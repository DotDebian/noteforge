import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import {
  createError,
  defineEventHandler,
  getRequestHeaders,
  readValidatedBody,
  setHeader,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { useDb } from '~/server/database/client'
import {
  attachments,
  chatMessages,
  chatSessions,
  documents,
} from '~/server/database/schema'
import { assertDocumentAccess, assertFolderAccess, assertWorkspaceAccess } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { getDek } from '~/server/utils/dek'
import { getWorkspaceKey } from '~/server/utils/workspace-key'
import {
  decryptChatMessageContent,
  decryptDocument,
  encryptChatFollowups,
  encryptChatMessageContent,
  encryptChatMeta,
  encryptChatSessionTitle,
  encryptChatSources,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'
import {
  mistralChat,
  mistralChatStream,
  mistralEmbed,
  type MistralMessage,
  type MistralMessageContentPart,
} from '~/server/utils/mistral'
import { bestSentence } from '~/server/utils/best-sentence'
import { extractCitations } from '~/server/utils/citations'
import { deriveSessionTitle } from '~/server/utils/chat-title'
import { applyRateLimit } from '~/server/utils/rate-limit'
import { readAttachment } from '~/server/utils/storage'
import {
  SEARCH_SNIPPET_MAX,
  SEARCH_TOP_K,
  rankChunks,
} from '~/server/utils/search'
import { rerankChunks, getRerankerCircuitOpen } from '~/server/utils/rerank'
import { rewriteQuery } from '~/server/utils/query-rewrite'
import { FAST_MODEL } from '~/server/utils/query-rewrite'
import { logRagQuality } from '~/server/utils/ragQuality'
import { tavilySearch, tavilyExtract, type WebSearchDebug } from '~/server/utils/web-search'

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const HISTORY_MAX = 10
const SNIPPET_MAX = 500           // prompt context: per-chunk cap shown to Mistral
                                  // (raised from 320: web search snippets carry the actual
                                  // facts — cutting them off makes the model fall back to the
                                  // title, which is the article name not the entity name.)
const SOURCE_SNIPPET_MAX = SEARCH_SNIPPET_MAX
/** First-stage candidate pool size before the LLM reranker trims. */
const RERANK_POOL = 18
/** Max web results to retain when the web-fallback flag is on. */
const WEB_MAX_SOURCES = 4
/** How many of the top web hits to deep-extract (full page content) via Tavily Extract. */
const WEB_EXTRACT_TOP = 2
/** Prompt-context cap for a web entry. Larger than SNIPPET_MAX because deep-
 *  extracted pages carry the real facts — but still bounded so a 25 KB article
 *  doesn't blow the context window. */
const WEB_SNIPPET_MAX = 2500
/** Max base64-inline size for an attachment when the server URL isn't fetchable. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/*  Input                                                                      */
/* -------------------------------------------------------------------------- */

const Body = z.object({
  workspaceId: z.number().int().positive(),
  sessionId: z.number().int().positive().optional(),
  scopeFolderId: z.number().int().positive().nullable().optional(),
  scopeDocId: z.number().int().positive().nullable().optional(),
  message: z.string().trim().min(1).max(8000),
  /* ---- Wave 2 / I3 (regenerate-with-options) ---- */
  model: z.string().min(1).max(80).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /* ---- Wave 2 / N5 (web fallback) ---- */
  webFallback: z.boolean().optional(),
  /* ---- Wave 3 / N6 (deep reasoning) ---- */
  reasoning: z.boolean().optional(),
  /* ---- Wave 4 / N7 (image attachment) ---- */
  attachmentId: z.number().int().positive().nullable().optional(),
  /* ---- Wave 4 / N8 (agentic tool calls) ---- */
  allowWrites: z.boolean().optional(),
})

interface SourceRef {
  docId: number
  chunkIdx: number
  snippet: string
  title: string
  /** Unix seconds — stamped on note sources so the UI can flag stale citations. */
  docUpdatedAt?: number
}

/** A web search hit promoted into the same citation pool as note chunks. */
interface WebSourceRef {
  /** Hint that this slot is a web result; carries 0 for both ids so it never collides with a real note. */
  docId: 0
  chunkIdx: 0
  snippet: string
  title: string
  url: string
}

type AnySource = SourceRef | WebSourceRef

interface RefinedSource {
  docId: number
  chunkIdx: number
  snippet: string
  title: string
  /** Citation number as it appears in the assistant text ([#N]). */
  citation: number
  /** The single sentence inside the chunk that best matches the answer. */
  highlight: string
  /** Snapshot of the source doc's updatedAt at answer time, for stale-badge UX. */
  docUpdatedAt?: number
  /** Source kind; web results travel through the same source-chip pipeline. */
  kind?: 'note' | 'web'
  url?: string
}

/* -------------------------------------------------------------------------- */
/*  Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT_BASE = `You are NoteForge Chat, a focused assistant for the user's own notes.

CONTEXT format:
You will receive a "CONTEXT" section containing numbered entries. Each entry
looks like:
  [#N] (Note|Web) <title> — <snippet>
The TITLE is just the source's name (filename for notes, article headline for
web). The SNIPPET is the actual content. Always read facts from the snippet,
NEVER from the title — a web title like "Top 10 Alternatives to TIMIFY" is the
article's headline, not a company name. Extract the real entities from the
body.

CITATION RULES:
- Cite inline as [#N] using the numeric markers shown next to each entry.
- Each [#N] must back a SPECIFIC factual claim drawn from that entry's snippet.
- Do NOT decorate a bullet point with [#N] just because the title contains the
  topic keyword — only cite when the snippet itself supports the claim.
- If you have to enumerate items (competitors, features, dates…), extract them
  from the snippets and group them. Do NOT list source titles as if they were
  the items themselves.

CRITICAL — what you CAN and CANNOT do this turn:
- You CANNOT take actions between turns. You cannot "go look", "search now",
  "check later", or run any process while writing this reply.
- NEVER write filler like "[searching…]", "let me look", "un instant",
  "I'll go check", or any phrasing that implies background work. Either the
  answer is in CONTEXT already, or it isn't.
- If the answer is NOT in CONTEXT, say so plainly in ONE short sentence
  ("Je n'ai pas trouvé cette information dans tes notes." / "I don't see this
  in your notes."). Do not fabricate facts to fill the gap.

Be concise. Prefer short paragraphs over long bullet lists. Reply in the user's
language.`

const SYSTEM_PROMPT_WEB_OFF = `You do NOT have web access this turn. If the user asks anything that would
require external sources (who, what, when about a person/product/event you
have no info on, current events, prices, etc.), reply concisely:
"Je n'ai pas trouvé cette information dans tes notes. Active l'option
\\"Chercher sur le web\\" dans la barre de saisie pour que je puisse aller
voir en ligne."  (or the English equivalent if the user is writing in
English). Do NOT invent facts. Do NOT pretend you searched.`

const SYSTEM_PROMPT_WEB_AVAILABLE = `You have a \`web_search\` tool. Use it ONLY when the answer is not already in
CONTEXT and requires external/current information (current events, prices,
people/products/companies the notes don't cover). If CONTEXT already answers
the question, reply directly — do NOT search. When you do search, call
\`web_search\` with a single focused query and write nothing else that turn;
the search results will come back and you'll answer from them. Never claim you
searched when you didn't.`

const SYSTEM_PROMPT_WEB_ON_HIT = `Web search ran for this turn and returned results, marked "(Web)" in CONTEXT.

How to use web results correctly:
- The TITLE of a web entry is an article headline, NOT a company / product /
  person name. Example: "[#7] (Web) Top 10 Alternatives to TIMIFY — <snippet>"
  is an ARTICLE about Timify alternatives. The actual alternatives are NAMED
  INSIDE the snippet.
- When the user asks "what are X's competitors?" or "who is X?" or any
  entity-extraction question, pull the entity names from the SNIPPETS and
  group them. Cite each named entity with the [#N] of the snippet that
  mentioned it. Never list article titles as if they were the answer.
- When snippets disagree or are sparse, say so explicitly. Don't pad.`

const SYSTEM_PROMPT_WEB_ON_MISS = `Web search ran for this turn but returned no usable results. Tell the user
plainly in ONE sentence that nothing matched online (in their language). Do
NOT pretend further search is happening; do NOT invent facts.`

/**
 * Extra system prompt when the user has allowed write tools. Spelled out
 * explicitly so the model knows the tools are for note mutations (not
 * generic search). All tool calls go through a user-approval gate.
 */
const TOOLS_SYSTEM_PROMPT = `You may also call note-mutation tools (\`create_note\`, \`update_note\`, \`delete_note\`) when the user explicitly asks you to author or modify a note. Every tool call requires the user's approval before it runs — so be clear about what you intend to do. Prefer a single tool call per turn.`

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= n) return cleaned
  return `${cleaned.slice(0, n - 1).trimEnd()}…`
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/* -------------------------------------------------------------------------- */
/*  Vision helpers (N7)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a fetchable absolute URL Mistral's servers can pull the image from.
 * In local dev this lands on `localhost`/`127.0.0.1` which Mistral can't
 * reach — callers should detect that case and fall back to base64 inlining.
 */
function buildAttachmentUrl(event: H3Event, attachmentId: number): string {
  const headers = getRequestHeaders(event)
  const proto = (headers['x-forwarded-proto'] as string | undefined) ?? 'http'
  const host = (headers['host'] as string | undefined) ?? 'localhost:3000'
  return `${proto}://${host}/api/uploads/${attachmentId}`
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase()
  return h.startsWith('localhost')
    || h.startsWith('127.0.0.1')
    || h.startsWith('0.0.0.0')
    || h.startsWith('::1')
    || /^192\.168\./.test(h)
    || /^10\./.test(h)
}


/* -------------------------------------------------------------------------- */
/*  Suggested follow-ups (N4)                                                   */
/* -------------------------------------------------------------------------- */

async function generateFollowups(question: string, answer: string, userId: number): Promise<string[]> {
  try {
    const { content } = await mistralChat({
      messages: [
        {
          role: 'system',
          content: 'You suggest 2-3 short, natural follow-up questions the user might ask next, in the user\'s language. Respond as JSON: {"questions": ["…", "…"]}. Keep each question under 100 chars. Do not number them.',
        },
        {
          role: 'user',
          content: `Question:\n${truncate(question, 600)}\n\nAnswer:\n${truncate(answer, 1200)}\n\nReturn JSON.`,
        },
      ],
      jsonMode: true,
      temperature: 0.3,
      model: FAST_MODEL,
      userId,
      operation: 'followups',
    })
    const parsed = JSON.parse(content) as { questions?: unknown }
    if (!Array.isArray(parsed.questions)) return []
    const out: string[] = []
    for (const q of parsed.questions) {
      if (typeof q !== 'string') continue
      const cleaned = q.trim()
      if (cleaned.length === 0 || cleaned.length > 200) continue
      out.push(cleaned)
      if (out.length >= 3) break
    }
    return out
  }
  catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/*  Agentic tool descriptors (N8)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Web-search function tool offered to the model on every turn (when a Tavily
 * key is configured). The model decides whether to call it — "enabled by
 * default, used if needed". When it fires we run Tavily, fold the hits into
 * CONTEXT, and re-stream the answer (see the handler's streaming loop).
 */
const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the public web for current or external facts that are NOT in the user\'s notes (current events, prices, people/products/companies the notes do not cover). Do not call this when the answer is already in CONTEXT.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A focused web search query. Resolve pronouns/anaphora from the conversation into a standalone query.' },
      },
      required: ['query'],
    },
  },
}

const WRITE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_note',
      description: 'Create a new note in the current workspace. The user will be asked to approve before the note is created.',
      parameters: {
        type: 'object',
        properties: {
          workspaceId: { type: 'number', description: 'Workspace id (use the active workspace).' },
          folderId: { type: ['number', 'null'], description: 'Optional folder to place the note in. Null for the workspace root.' },
          title: { type: 'string', description: 'Title of the note.' },
          markdown: { type: 'string', description: 'Initial markdown body.' },
        },
        required: ['workspaceId', 'title', 'markdown'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_note',
      description: 'Patch an existing note. Pass only the fields you want to change.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'number', description: 'Id of the note to update.' },
          title: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['documentId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_note',
      description: 'Move a note to the trash. Reversible from the trash UI.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'number' },
        },
        required: ['documentId'],
      },
    },
  },
]

interface ProposedToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * Inspect a non-streaming Mistral response and extract any function-style
 * tool calls. Returns an empty array when the model chose to just chat.
 */
function extractToolCalls(raw: unknown): ProposedToolCall[] {
  const out: ProposedToolCall[] = []
  const message = (raw as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> })
    ?.choices?.[0]?.message
  const calls = message?.tool_calls
  if (!Array.isArray(calls)) return out
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue
    const fn = (c as { function?: { name?: string, arguments?: unknown } }).function
    if (!fn?.name) continue
    let args: Record<string, unknown> = {}
    if (typeof fn.arguments === 'string') {
      try { args = JSON.parse(fn.arguments) as Record<string, unknown> }
      catch { args = {} }
    }
    else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>
    }
    out.push({ name: fn.name, arguments: args })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Handler                                                                    */
/* -------------------------------------------------------------------------- */

export default defineEventHandler(async (event) => {
  const requestStart = Date.now()
  const user = await requireUser(event)
  // Two keys: `dek` for per-user state (chat session/messages stored on
  // the user's row) and `workspaceKey` for workspace content (doc titles
  // + chunks). They differ only when this workspace is shared (`'wek'`).
  const dek = await getDek(event)
  applyRateLimit(event, user.id, 'chat')
  const input = await readValidatedBody(event, Body.parse)

  await assertWorkspaceAccess(event, input.workspaceId)
  const workspaceKey = await getWorkspaceKey(event, input.workspaceId)

  // Doc scope (F11) takes precedence over folder scope when both are supplied.
  const effectiveDocId: number | null = input.scopeDocId ?? null
  const effectiveFolderId: number | null = effectiveDocId != null ? null : (input.scopeFolderId ?? null)

  if (effectiveDocId != null) {
    const doc = await assertDocumentAccess(event, effectiveDocId)
    if (doc.workspaceId !== input.workspaceId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Document must belong to the workspace',
      })
    }
  }
  else if (effectiveFolderId != null) {
    const folder = await assertFolderAccess(event, effectiveFolderId)
    if (folder.workspaceId !== input.workspaceId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Folder must belong to the workspace',
      })
    }
  }

  const db = useDb()

  /* ---------- 1. Resolve or create the chat session ---------------------- */
  let sessionId = input.sessionId
  if (sessionId != null) {
    const [existing] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1)
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
    if (existing.userId !== user.id) throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
    if (existing.workspaceId !== input.workspaceId) {
      throw createError({ statusCode: 400, statusMessage: 'Session/workspace mismatch' })
    }
  }
  else {
    const title = deriveSessionTitle(input.message)
    const [created] = await db
      .insert(chatSessions)
      .values({
        userId: user.id,
        workspaceId: input.workspaceId,
        scopeFolderId: effectiveFolderId,
        scopeDocId: effectiveDocId,
        title: encryptChatSessionTitle(title, dek),
      })
      .returning()
    if (!created) throw createError({ statusCode: 500, statusMessage: 'Failed to create chat session' })
    sessionId = created.id
  }

  /* ---------- 1b. Resolve attachment (N7) -------------------------------- */
  // Loaded eagerly so we can reject early if the user supplied a bad id.
  // Two outputs:
  //  - `imageContentPart`: the `image_url` chunk to splice into the final
  //    user message when calling Mistral. Built lazily so we don't read the
  //    file off disk unless we need the base64 fallback path.
  //  - `messageMarkdownPrefix`: an inline markdown image tag the chat
  //    component renders as a thumbnail above the user's text.
  let imageContentPart: MistralMessageContentPart | null = null
  let messageMarkdownPrefix = ''
  let visionRouting: 'pixtral' | null = null

  if (input.attachmentId != null) {
    const [rec] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, input.attachmentId))
      .limit(1)
    if (!rec) {
      throw createError({ statusCode: 404, statusMessage: 'Attachment not found' })
    }
    if (rec.workspaceId !== input.workspaceId) {
      throw createError({ statusCode: 400, statusMessage: 'Attachment workspace mismatch' })
    }
    if (!rec.mime.startsWith('image/')) {
      throw createError({ statusCode: 415, statusMessage: 'Attachment must be an image' })
    }

    // Pick the URL path Mistral will actually be able to fetch.
    const headers = getRequestHeaders(event)
    const host = (headers['host'] as string | undefined) ?? ''
    const useInline = host === '' || isLocalHost(host)

    if (useInline) {
      try {
        const buf = await readAttachment(rec)
        if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) {
          console.warn(`[ai/chat] attachment ${rec.id} too large for base64 inline (${buf.byteLength} bytes) — skipping image`)
        }
        else {
          const dataUrl = `data:${rec.mime};base64,${buf.toString('base64')}`
          imageContentPart = { type: 'image_url', image_url: dataUrl }
        }
      }
      catch (err) {
        console.warn('[ai/chat] failed to inline attachment', rec.id, (err as Error).message)
      }
    }
    else {
      imageContentPart = { type: 'image_url', image_url: buildAttachmentUrl(event, rec.id) }
    }

    // Whether or not the image actually made it through to Mistral, we surface
    // the inline reference in the persisted markdown so the chat history shows
    // a thumbnail. Use the relative URL — the client served it.
    messageMarkdownPrefix = `![image](/api/uploads/${rec.id})\n\n`

    if (imageContentPart != null) visionRouting = 'pixtral'
  }

  /* ---------- 2. Persist the user message -------------------------------- */
  const persistedUserMessage = `${messageMarkdownPrefix}${input.message}`
  await db.insert(chatMessages).values({
    sessionId,
    role: 'user',
    content: encryptChatMessageContent(persistedUserMessage, dek),
    sources: [],
  })

  /* ---------- 3. Load history (so the rewriter has context) -------------- */
  const historyRows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.id))
    .limit(HISTORY_MAX * 2 + 1)

  // Newest-first → reverse to chronological; drop the very last entry which
  // is the user message we just inserted (we'll add it explicitly).
  const history = historyRows.slice().reverse()
  if (history.length > 0 && history[history.length - 1]?.role === 'user') {
    history.pop()
  }

  const historyMessages: MistralMessage[] = history
    .filter(h => h.role === 'user' || h.role === 'assistant')
    .map(h => ({ role: h.role as 'user' | 'assistant', content: decryptChatMessageContent(h.content, dek) }))
    .slice(-HISTORY_MAX)

  /* ---------- 4. Web search availability (Tavily tool) ------------------- */
  // Query rewriting + note retrieval now run INSIDE the SSE stream (step 7) so
  // the client can render genuine "Réflexion → Recherche dans les notes →
  // Recherche web" step frames with real running/done timing. The web search,
  // as before, is exposed to the model as a `web_search` function tool: it is
  // available whenever a Tavily key is configured (the MODEL decides to call
  // it; the persistent `webFallback` toggle FORCES it this turn).
  const webEnabled = typeof (useRuntimeConfig().tavilyApiKey) === 'string'
    && (useRuntimeConfig().tavilyApiKey as string).length > 0
  const forceWeb = input.webFallback === true && webEnabled

  /* ---------- 6. Build the prompt ---------------------------------------- */
  // The CONTEXT block is rebuilt whenever the source pool changes (e.g. after
  // a web search folds new hits in), so the [#N] citation numbering stays
  // consistent between the prompt and the post-stream refinement.
  function buildContextBlock(srcs: AnySource[]): string {
    if (srcs.length === 0) return 'CONTEXT: (no notes matched this query)'
    const lines: string[] = ['CONTEXT (retrieved from the user\'s notes and the web):']
    srcs.forEach((s, i) => {
      const isWeb = 'url' in s
      lines.push(`[#${i + 1}] (${isWeb ? 'Web' : 'Note'}) ${s.title} — ${truncate(s.snippet, isWeb ? WEB_SNIPPET_MAX : SNIPPET_MAX)}`)
    })
    return lines.join('\n')
  }

  // The "real" user message — string when plain, array when an image was attached.
  const finalUserContent: MistralMessage['content'] = imageContentPart
    ? [
        { type: 'text', text: input.message },
        imageContentPart,
      ]
    : input.message

  // Assemble the full message list: base policy + capability disclosure + the
  // retrieved CONTEXT block + optional tools clause, then history + user turn.
  // `capabilityClause` shifts across passes: before any web search the model is
  // told it HAS a web_search tool; after one runs it gets the hit/miss guidance.
  function composeMessages(capabilityClause: string, srcs: AnySource[]): MistralMessage[] {
    const systemMessages: MistralMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT_BASE },
      { role: 'system', content: capabilityClause },
      { role: 'system', content: buildContextBlock(srcs) },
    ]
    if (input.allowWrites) {
      systemMessages.push({ role: 'system', content: TOOLS_SYSTEM_PROMPT })
    }
    return [...systemMessages, ...historyMessages, { role: 'user', content: finalUserContent }]
  }

  const initialCapabilityClause = webEnabled ? SYSTEM_PROMPT_WEB_AVAILABLE : SYSTEM_PROMPT_WEB_OFF

  /* ---------- 6b. Model routing ------------------------------------------ */
  // Vision wins when an image is in play and the caller didn't pin a model.
  // For reasoning + image at the same time, image wins (Magistral isn't a
  // vision model). When the caller passed an explicit non-vision model with
  // an image, log a console.warn so the choice is visible in dev logs.
  let chatModel: string | undefined = input.model
  if (visionRouting === 'pixtral') {
    if (chatModel == null) {
      chatModel = 'pixtral-large-latest'
    }
    else if (!chatModel.toLowerCase().includes('pixtral')) {
      console.warn(`[ai/chat] image attached but caller pinned non-vision model "${chatModel}" — Mistral may ignore the image`)
    }
  }
  else if (chatModel == null && input.reasoning) {
    chatModel = 'magistral-medium-latest'
  }
  const chatTemperature = input.temperature
    ?? (input.reasoning && input.model == null ? 0.4 : 0.2)

  /* ---------- 7. Stream the response ------------------------------------- */
  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setHeader(event, 'Connection', 'keep-alive')
  setHeader(event, 'X-Accel-Buffering', 'no')
  setResponseStatus(event, 200)

  const finalSessionId = sessionId
  const userMessage = input.message
  const userId = user.id
  const allowWrites = input.allowWrites === true

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (obj: unknown) => controller.enqueue(enc.encode(sseFrame(obj)))
      let collected = ''
      let errored = false
      // Native citations (I6): when Mistral streams `reference` chunks we
      // record the 1-based source indices it actually referenced.
      const nativeCited = new Set<number>()

      send({ type: 'session', sessionId: finalSessionId })

      // Whether the model actually ran a web search this turn — resolved during
      // streaming when it calls the `web_search` tool. Drives the final `meta`
      // frame's web badge.
      let webUsed = false

      // ---- Steps 1 & 2: Réflexion (query rewrite) + Recherche dans les notes
      // These ran before the stream historically. Doing them here lets us emit
      // real running/done `step` frames the UI renders ABOVE the answer, so the
      // user sees "Réflexion… → terminée", "Recherche dans les notes… → N notes
      // trouvées" with genuine timing. Web search (step 3) follows mid-stream.
      let rewriterUsed = false
      let retrievalQuery = userMessage
      const noteSources: SourceRef[] = []
      let rerankerUsed = false
      let rerankScoreAvg: number | undefined
      let sources: AnySource[] = []
      const webSources: WebSourceRef[] = []
      let webDebug: WebSearchDebug | null = null

      send({ type: 'step', step: 'thinking', status: 'running' })
      try {
        rewriterUsed = historyMessages.length > 0
        retrievalQuery = await rewriteQuery(historyMessages, input.message, userId)
        send({ type: 'step', step: 'thinking', status: 'done' })

        send({ type: 'step', step: 'notes', status: 'running' })
        const queryVectors = await mistralEmbed([retrievalQuery], { userId, operation: 'embed_query' })
        const queryVec = queryVectors[0] ?? []

        const docFilters = effectiveDocId != null
          ? and(
            eq(documents.workspaceId, input.workspaceId),
            eq(documents.id, effectiveDocId),
            activeDocsWhere(),
          )
          : effectiveFolderId != null
            ? and(
              eq(documents.workspaceId, input.workspaceId),
              eq(documents.folderId, effectiveFolderId),
              activeDocsWhere(),
            )
            : and(eq(documents.workspaceId, input.workspaceId), activeDocsWhere())

        const candidateDocs = await db
          .select({ id: documents.id, title: documents.title, updatedAt: documents.updatedAt })
          .from(documents)
          .where(docFilters)

        const titleByDoc = new Map(
          candidateDocs.map(d => [d.id, decryptDocument({ title: d.title }, workspaceKey).title!] as const),
        )
        const updatedAtByDoc = new Map<number, number>(
          candidateDocs.map((d) => {
            const ts = d.updatedAt instanceof Date ? Math.floor(d.updatedAt.getTime() / 1000) : Number(d.updatedAt ?? 0)
            return [d.id, ts] as const
          }),
        )
        const candidateDocIds = candidateDocs.map(d => d.id)

        if (candidateDocIds.length > 0) {
          const scored = await rankChunks(candidateDocIds, queryVec, {
            perDocCap: Number.POSITIVE_INFINITY,
            topK: RERANK_POOL,
            queryText: retrievalQuery,
          }, workspaceKey)

          const rerankerSkipped = scored.length <= 1 || getRerankerCircuitOpen()
          rerankerUsed = !rerankerSkipped
          const reranked = await rerankChunks(retrievalQuery, scored, SEARCH_TOP_K * 2, userId)
          if (reranked.length > 0) {
            let sum = 0
            for (const r of reranked) sum += r.score
            rerankScoreAvg = sum / reranked.length
          }

          const finalCap = effectiveDocId != null ? Number.POSITIVE_INFINITY : 2
          const seenPerDoc = new Map<number, number>()
          for (const hit of reranked) {
            if (noteSources.length >= SEARCH_TOP_K) break
            const used = seenPerDoc.get(hit.docId) ?? 0
            if (used >= finalCap) continue
            seenPerDoc.set(hit.docId, used + 1)
            noteSources.push({
              docId: hit.docId,
              chunkIdx: hit.idx,
              snippet: truncate(hit.text, SOURCE_SNIPPET_MAX),
              title: titleByDoc.get(hit.docId) ?? 'Untitled',
              docUpdatedAt: updatedAtByDoc.get(hit.docId),
            })
          }
        }
        sources = [...noteSources]
        send({ type: 'step', step: 'notes', status: 'done', count: noteSources.length })
      }
      catch (err) {
        // Retrieval is failure-hard (no context = no useful answer). Stop the
        // spinners and surface an error frame; the client renders the error
        // bubble. Headers are already sent, so we can't fall back to HTTP 500.
        const detail = (err as { data?: { detail?: string }, message?: string }).data?.detail
          ?? (err as Error).message
          ?? 'retrieval failed'
        send({ type: 'step', step: 'thinking', status: 'done' })
        send({ type: 'step', step: 'notes', status: 'done', count: 0 })
        send({ type: 'error', error: 'retrieval_failed', detail })
        controller.close()
        return
      }

      // Build the prompt now that the note context is resolved.
      const messages: MistralMessage[] = composeMessages(initialCapabilityClause, sources)

      // N8 — tool-call pre-flight. When the user toggled `allowWrites`, run a
      // non-streaming probe first to see if the model wants to call a write
      // tool. If it does, surface the proposed call to the client and SKIP
      // streaming text — we don't want the bubble to be half-text-half-action.
      // The client renders an approve/reject card and posts to
      // `/api/ai/chat/sessions/:id/tool-call/approve` to execute or cancel.
      let toolCallEmitted = false
      if (allowWrites) {
        try {
          const probe = await mistralChat({
            messages,
            tools: WRITE_TOOLS,
            toolChoice: 'auto',
            temperature: chatTemperature,
            userId,
            operation: 'chat_tool_probe',
            ...(chatModel ? { model: chatModel } : {}),
          })
          const calls = extractToolCalls(probe.raw)
          if (calls.length > 0) {
            // Inject the workspace id when the model forgot it — we only let
            // the call run against the current workspace anyway.
            for (const c of calls) {
              if (c.name === 'create_note' && c.arguments.workspaceId == null) {
                c.arguments.workspaceId = input.workspaceId
              }
            }
            send({ type: 'tool_call_pending', calls })
            // Place a short placeholder in the assistant bubble so the user
            // sees something coherent instead of an empty message.
            const placeholder = probe.content.trim().length > 0
              ? probe.content.trim()
              : 'I would like to perform the following action — please review and approve.'
            collected = placeholder
            send({ type: 'delta', text: placeholder })
            toolCallEmitted = true
          }
        }
        catch (err) {
          // Failure-soft: fall through to normal streaming. The user just gets
          // an answer without tool calls — better than a hard 502.
          console.warn('[ai/chat] tool probe failed (non-fatal):', (err as Error).message)
        }
      }

      if (!toolCallEmitted) {
        // Up to two passes. Pass 1 offers the `web_search` tool; if the model
        // calls it we run Tavily (search + deep-extract), fold the hits into
        // CONTEXT, and pass 2 answers from the enriched context with no tools.
        // The common case (no web needed) finishes in pass 1.
        let passMessages = messages
        let passTools: Array<Record<string, unknown>> | undefined = webEnabled ? [WEB_SEARCH_TOOL] : undefined
        let passToolChoice: string | Record<string, unknown> | undefined = webEnabled
          ? (forceWeb ? { type: 'function', function: { name: 'web_search' } } : 'auto')
          : undefined

        for (let pass = 0; pass < 2; pass++) {
          let pendingWebQuery: string | null = null
          let textThisPass = false
          try {
            for await (const ev of mistralChatStream({
              messages: passMessages,
              temperature: chatTemperature,
              userId,
              operation: 'chat_stream',
              ...(passTools ? { tools: passTools, toolChoice: passToolChoice } : {}),
              ...(chatModel ? { model: chatModel } : {}),
            })) {
              if (ev.kind === 'text') {
                collected += ev.text
                textThisPass = true
                send({ type: 'delta', text: ev.text })
              }
              else if (ev.kind === 'reference') {
                for (const r of ev.refs) {
                  if (typeof r.id === 'number' && r.id >= 1 && r.id <= sources.length) {
                    nativeCited.add(r.id)
                    continue
                  }
                  if (typeof r.url === 'string' && r.url.length > 0) {
                    const idx = sources.findIndex(s => 'url' in s && (s as WebSourceRef).url === r.url)
                    if (idx >= 0) { nativeCited.add(idx + 1); continue }
                  }
                  if (typeof r.title === 'string' && r.title.length > 0) {
                    const needle = r.title.trim().toLowerCase()
                    const idx = sources.findIndex(s => s.title.trim().toLowerCase() === needle)
                    if (idx >= 0) { nativeCited.add(idx + 1); continue }
                  }
                }
              }
              else if (ev.kind === 'tool_call') {
                // Honor a web_search call only if the model led with it (no answer
                // text streamed yet) and we haven't already searched this turn.
                if (!webUsed && !textThisPass && collected.length === 0) {
                  const wc = ev.calls.find(c => c.name === 'web_search')
                  if (wc) {
                    let q = retrievalQuery
                    try {
                      const parsedArgs = JSON.parse(wc.arguments) as { query?: unknown }
                      if (typeof parsedArgs.query === 'string' && parsedArgs.query.trim().length > 0) {
                        q = parsedArgs.query.trim()
                      }
                    }
                    catch { /* malformed args → fall back to the rewritten retrieval query */ }
                    pendingWebQuery = q
                  }
                }
              }
            }
          }
          catch (err) {
            errored = true
            const detail = (err as { data?: { detail?: string }, message?: string }).data?.detail
              ?? (err as Error).message
              ?? 'unknown error'
            send({ type: 'error', error: 'mistral_failed', detail })
            break
          }

          // No web search requested → the streamed text is the answer.
          if (!pendingWebQuery || webUsed) break

          webUsed = true
          send({ type: 'step', step: 'web', status: 'running', query: truncate(pendingWebQuery, 200) })

          const searchResult = await tavilySearch(pendingWebQuery, { maxResults: WEB_MAX_SOURCES })
          webDebug = searchResult.debug

          // Deep-extract the top hits for full page content; fall back to the
          // search snippet for the rest (and on any extract failure).
          const topUrls = searchResult.hits.slice(0, WEB_EXTRACT_TOP).map(h => h.url)
          let extractByUrl = new Map<string, string>()
          if (topUrls.length > 0) {
            const ext = await tavilyExtract(topUrls)
            extractByUrl = ext.byUrl
          }
          for (const h of searchResult.hits) {
            const extracted = extractByUrl.get(h.url)
            const body = extracted && extracted.length > 0 ? extracted : h.snippet
            webSources.push({
              docId: 0,
              chunkIdx: 0,
              snippet: truncate(body, WEB_SNIPPET_MAX),
              title: h.title,
              url: h.url,
            })
          }
          sources = [...noteSources, ...webSources]

          // Surface the finished search + its results (title + url) so the
          // "Recherche web — N résultats" step can list the sources inline.
          send({
            type: 'step',
            step: 'web',
            status: 'done',
            query: truncate(pendingWebQuery, 200),
            count: webSources.length,
            sources: webSources.map(s => ({ title: s.title, url: s.url })),
          })

          // Recompose for pass 2: enriched CONTEXT + hit/miss guidance, no tools.
          const clause = webSources.length > 0 ? SYSTEM_PROMPT_WEB_ON_HIT : SYSTEM_PROMPT_WEB_ON_MISS
          passMessages = composeMessages(clause, sources)
          passTools = undefined
          passToolChoice = undefined
        }
      }

      // ---- Post-stream refinement -----------------------------------------
      const cited = nativeCited.size > 0 ? nativeCited : extractCitations(collected)
      const refined: RefinedSource[] = []
      for (let i = 0; i < sources.length; i++) {
        const n = i + 1
        if (!cited.has(n)) continue
        const s = sources[i]
        if (!s) continue
        const isWeb = 'url' in s
        refined.push({
          docId: s.docId,
          chunkIdx: s.chunkIdx,
          // Clamp to the display cap — web entries hold up to WEB_SNIPPET_MAX of
          // extracted page text for the prompt, far more than a chip should show.
          snippet: truncate(s.snippet, SOURCE_SNIPPET_MAX),
          title: s.title,
          citation: n,
          highlight: isWeb ? '' : bestSentence(s.snippet, collected),
          ...(isWeb ? {} : { docUpdatedAt: (s as SourceRef).docUpdatedAt }),
          ...(isWeb ? { kind: 'web' as const, url: (s as WebSourceRef).url } : { kind: 'note' as const }),
        })
      }

      const refinedForClient = refined.map(s => ({
        docId: s.docId,
        chunkIdx: s.chunkIdx,
        title: s.title,
        snippet: s.snippet,
        highlight: s.highlight,
        citation: s.citation,
        ...(s.docUpdatedAt !== undefined ? { docUpdatedAt: s.docUpdatedAt } : {}),
        ...(s.kind ? { kind: s.kind } : {}),
        ...(s.url ? { url: s.url } : {}),
      }))

      // ---- Follow-ups (computed before persist so they can be saved) -------
      // Follow-ups make no sense when we just emitted a tool-call card — the
      // user's next action is "approve / reject", not "ask a follow-up".
      const followups = !errored && !toolCallEmitted && collected.trim().length > 0
        ? await generateFollowups(userMessage, collected, userId)
        : []

      // ---- Per-turn meta (persisted + sent for the debug panel / web badge) -
      const effectiveModel = chatModel
        ?? (useRuntimeConfig().mistralChatModel as string | undefined)
        ?? 'mistral-medium-latest'
      const metaObj = {
        model: effectiveModel,
        webRequested: input.webFallback === true,
        webAuto: webUsed && input.webFallback !== true,
        webUsed,
        webHits: webSources.length,
        webDebug,
        noteHits: noteSources.length,
        retrievalQuery: retrievalQuery.length > 240 ? `${retrievalQuery.slice(0, 240)}…` : retrievalQuery,
        rewriterUsed,
        rerankerUsed,
        rerankScoreAvg: rerankScoreAvg ?? null,
        reasoning: input.reasoning === true,
        attachmentId: input.attachmentId ?? null,
        allowWrites,
        scopeDocId: effectiveDocId,
        scopeFolderId: effectiveFolderId,
        temperature: chatTemperature,
      }

      let persistedMessageId: number | null = null
      let persistedCreatedAt: number | null = null
      try {
        const [row] = await useDb().insert(chatMessages).values({
          sessionId: finalSessionId,
          role: 'assistant',
          content: encryptChatMessageContent(collected, dek),
          sources: encryptChatSources(
            refined.map(s => ({
              docId: s.docId,
              chunkIdx: s.chunkIdx,
              snippet: s.snippet,
              highlight: s.highlight,
              citation: s.citation,
              ...(s.docUpdatedAt !== undefined ? { docUpdatedAt: s.docUpdatedAt } : {}),
              ...(s.kind ? { kind: s.kind } : {}),
              ...(s.url ? { url: s.url } : {}),
              ...(s.kind === 'web' ? { title: s.title } : {}),
            })),
            dek,
          ),
          // History parity: persist the follow-up chips + meta so reopening the
          // session renders identically to the live turn (instead of a bare
          // content + sources).
          followups: encryptChatFollowups(followups, dek),
          meta: encryptChatMeta(metaObj, dek),
        }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt })
        if (row) {
          persistedMessageId = row.id
          persistedCreatedAt = row.createdAt instanceof Date
            ? Math.floor(row.createdAt.getTime() / 1000)
            : Number(row.createdAt ?? 0)
        }
      }
      catch (err) {
        console.error('[ai/chat] failed to persist assistant message', err)
      }

      if (!errored) {
        // Meta first so the debug panel / web badge can populate, then the
        // follow-up chips, then the terminal `done` frame.
        send({ type: 'meta', ...metaObj })

        if (followups.length > 0) {
          send({ type: 'followups', items: followups })
        }

        send({
          type: 'done',
          sessionId: finalSessionId,
          sources: refinedForClient,
          messageId: persistedMessageId,
          createdAt: persistedCreatedAt,
        })
      }

      logRagQuality({
        sessionId: finalSessionId,
        userId,
        chunksReturned: sources.length,
        rerankScoreAvg,
        citationsEmitted: refinedForClient.length,
        hasCitation: refinedForClient.length > 0,
        rewriterUsed,
        rerankerUsed,
        latencyMs: Date.now() - requestStart,
      })

      controller.close()
    },
  })

  return stream
})
