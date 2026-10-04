import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import {
  createError,
  defineEventHandler,
  readValidatedBody,
  setHeader,
  setResponseStatus,
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
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import {
  CLAUDE_IMAGE_MIMES,
  claudeChat,
  claudeChatStream,
  getClaudeModel,
  type ChatContentPart,
  type ChatMessage,
  type ClaudeImageMime,
} from '~/server/utils/claude'
import { embedTextsSoft } from '~/server/utils/embeddings'
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
import { logRagQuality } from '~/server/utils/ragQuality'
import { tavilySearch, tavilyExtract, type WebSearchDebug } from '~/server/utils/web-search'

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const HISTORY_MAX = 10
const SNIPPET_MAX = 500           // prompt context: per-chunk cap shown to the model
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
/** Max size for an attached image, which is sent to Claude inline as base64. */
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
  // Accepted for older clients, ignored: Claude exposes no sampling knobs.
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

const SYSTEM_PROMPT_BASE = `You are NoteForge Chat, an assistant that answers questions from the user's own notes.

Each turn you receive a CONTEXT section: numbered entries retrieved for this question, formatted as
  [#N] (Note|Web) <title> — <snippet>
The title is only the source's name (a note's filename, a web article's headline); the snippet is the actual content. Take facts from snippets, not titles: a web title like "Top 10 Alternatives to TIMIFY" is an article headline, not a company name, and the real entities are named in the body.

Citations:
- Cite inline as [#N], using the number shown next to the entry. The app turns these markers into clickable source chips, and only the entries you cite are shown to the user.
- Each [#N] should back a specific claim that the entry's snippet supports. Don't attach a citation just because the title mentions the topic.
- When you enumerate items (competitors, features, dates…), extract them from the snippets and group them, rather than listing source titles as if they were the items.

You answer in a single reply and cannot act between turns: retrieval already ran before you were called, so there is nothing left to "go look up". Don't write things like "let me check", "un instant" or "[searching…]"; either the answer is in CONTEXT or it isn't. When it isn't, say so plainly in one short sentence ("Je n'ai pas trouvé cette information dans tes notes." / "I don't see this in your notes.") rather than filling the gap with guesses.

Be concise: short paragraphs rather than long bullet lists. Reply in the user's language.`

const SYSTEM_PROMPT_WEB_OFF = `Web search is not available this turn. If the question needs external sources (a person, product or event the notes say nothing about, current events, prices…), reply concisely: "Je n'ai pas trouvé cette information dans tes notes. Active l'option \\"Chercher sur le web\\" dans la barre de saisie pour que je puisse aller voir en ligne." (or the English equivalent if the user writes in English). Don't invent facts and don't imply that you searched.`

const SYSTEM_PROMPT_WEB_ON_HIT = `A web search ran for this turn; its results are the entries marked "(Web)" in CONTEXT.

- A web entry's title is an article headline, not a company, product or person name. "[#7] (Web) Top 10 Alternatives to TIMIFY — <snippet>" is an article about Timify alternatives; the alternatives themselves are named inside the snippet. For entity questions ("what are X's competitors?", "who is X?"), pull the names from the snippets, group them, and cite each with the [#N] of the snippet that mentions it.
- Web results are keyword matches and can be about a different subject that merely shares a name (another game, franchise or product). Use a result only if it is clearly about the same thing the user is asking about, especially when the notes establish a specific universe or context; otherwise leave it out entirely, uncited and unmentioned. For example, a World-of-Warcraft page is not a source for a Minecraft item. If none of the results match, say plainly that nothing relevant was found online.
- When snippets disagree or are sparse, say so rather than padding.`

const SYSTEM_PROMPT_WEB_ON_MISS = `A web search ran for this turn but returned no usable results. Tell the user in one sentence, in their language, that nothing matched online. Don't suggest that more searching is under way, and don't invent facts.`

/**
 * Sentinel the model emits on the FIRST (notes-only) pass when the notes don't
 * contain the answer. The server intercepts it (never shown to the user) and
 * escalates to a web search instead. Kept distinctive so natural prose can't
 * collide with it.
 */
const NO_NOTES_SENTINEL = '__NO_NOTES__'

const SYSTEM_PROMPT_NOTES_FIRST = `Answer the user's question using only the notes in CONTEXT.

- If CONTEXT contains the answer, reply normally with inline [#N] citations.
- If it does not (including when it only holds loosely related notes that don't actually answer the question), your entire reply must be exactly this token, with nothing before or after it:
${NO_NOTES_SENTINEL}
  The app intercepts that token, runs a web search and asks you again with the results, so the user never sees it. That is why no apology or explanation should accompany it, and why it takes precedence over the instruction above to say you didn't find the information.
- Either the notes answer the question (reply) or they don't (the token alone); don't pad a non-answer.`

/**
 * System prompt for the write-action probe, sent when the user has allowed
 * note mutations. Every proposed action goes through a user-approval gate.
 */
const WRITE_PROBE_PROMPT = `The user has enabled note editing for this conversation. You can propose note actions, which the app shows them as an approve/reject card; nothing runs until they approve.

Available actions:
- create_note: create a note in the current workspace. Needs "title" and "markdown" (the full body). Optional "folderId"; leave it out for the workspace root.
- update_note: change an existing note. Needs "documentId", plus "title" and/or "markdown" for the fields to change; "markdown" replaces the whole body.
- delete_note: move a note to the trash (reversible from the trash UI). Needs "documentId".

Propose an action only when the user's current message explicitly asks you to write, modify or delete a note. For anything else (a question, a discussion), return an empty "calls" array and an empty "message": the question is then answered in a separate step. Prefer a single action per turn. When you do propose one, "message" is one short sentence in the user's language saying what you intend to do.`

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= n) return cleaned
  return `${cleaned.slice(0, n - 1).trimEnd()}…`
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/* -------------------------------------------------------------------------- */
/*  Suggested follow-ups (N4)                                                   */
/* -------------------------------------------------------------------------- */

async function generateFollowups(question: string, answer: string, userId: number): Promise<string[]> {
  try {
    const { content } = await claudeChat({
      messages: [
        {
          role: 'system',
          content: 'You suggest follow-up questions for a chat about the user\'s notes. Given the question they asked and the answer they received, write 2 or 3 short, natural questions they might ask next, in the user\'s language, each under 100 characters. They are shown as clickable chips, so output one question per line and nothing else: no numbering, no bullets, no introduction.',
        },
        {
          role: 'user',
          content: `Question:\n${truncate(question, 600)}\n\nAnswer:\n${truncate(answer, 1200)}`,
        },
      ],
      userId,
      operation: 'followups',
    })
    const out: string[] = []
    for (const line of content.split('\n')) {
      const cleaned = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
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
/*  Agentic write actions (N8)                                                 */
/* -------------------------------------------------------------------------- */

const WRITE_ACTIONS = ['create_note', 'update_note', 'delete_note'] as const

/**
 * Structured-output schema for the write probe. Arguments are flat on the
 * call object (each action reads the subset it needs) so the schema stays
 * closed — `toProposedCalls` reshapes them into `{ name, arguments }`.
 */
const WRITE_PROBE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: [...WRITE_ACTIONS] },
          folderId: { type: 'number' },
          documentId: { type: 'number' },
          title: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  required: ['message', 'calls'],
  additionalProperties: false,
}

interface ProposedToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * Turn the probe's structured output into the tool calls the client's
 * approval card expects, dropping any call missing what its action needs.
 * Returns an empty array when the model chose to just chat.
 */
function toProposedCalls(structured: unknown, workspaceId: number): ProposedToolCall[] {
  const calls = (structured as { calls?: unknown })?.calls
  if (!Array.isArray(calls)) return []
  const out: ProposedToolCall[] = []
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue
    const { name, folderId, documentId, title, markdown } = c as Record<string, unknown>
    if (name === 'create_note') {
      if (typeof title !== 'string' || typeof markdown !== 'string') continue
      // We only let the call run against the current workspace anyway.
      out.push({
        name,
        arguments: { workspaceId, folderId: typeof folderId === 'number' ? folderId : null, title, markdown },
      })
    }
    else if (name === 'update_note') {
      if (typeof documentId !== 'number') continue
      if (typeof title !== 'string' && typeof markdown !== 'string') continue
      out.push({
        name,
        arguments: {
          documentId,
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof markdown === 'string' ? { markdown } : {}),
        },
      })
    }
    else if (name === 'delete_note') {
      if (typeof documentId !== 'number') continue
      out.push({ name, arguments: { documentId } })
    }
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
  //  - `imageContentPart`: the base64 image part to splice into the final
  //    user message when calling Claude.
  //  - `messageMarkdownPrefix`: an inline markdown image tag the chat
  //    component renders as a thumbnail above the user's text.
  let imageContentPart: ChatContentPart | null = null
  let messageMarkdownPrefix = ''

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

    const mediaType = CLAUDE_IMAGE_MIMES.find((m): m is ClaudeImageMime => m === rec.mime)
    if (!mediaType) {
      console.warn(`[ai/chat] attachment ${rec.id} has a mime Claude can't read (${rec.mime}) — skipping image`)
    }
    else {
      try {
        const buf = await readAttachment(rec)
        if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) {
          console.warn(`[ai/chat] attachment ${rec.id} too large for base64 inline (${buf.byteLength} bytes) — skipping image`)
        }
        else {
          imageContentPart = { type: 'image', mediaType, data: buf.toString('base64') }
        }
      }
      catch (err) {
        console.warn('[ai/chat] failed to inline attachment', rec.id, (err as Error).message)
      }
    }

    // Whether or not the image actually made it through to Claude, we surface
    // the inline reference in the persisted markdown so the chat history shows
    // a thumbnail. Use the relative URL — the client served it.
    messageMarkdownPrefix = `![image](/api/uploads/${rec.id})\n\n`
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

  const historyMessages: ChatMessage[] = history
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
  const finalUserContent: ChatMessage['content'] = imageContentPart
    ? [
        { type: 'text', text: input.message },
        imageContentPart,
      ]
    : input.message

  // Assemble the full message list: base policy + capability clause + the
  // retrieved CONTEXT block, then history + user turn.
  // `capabilityClause` shifts across passes: pass 1 gets the notes-first probe
  // clause; after a web search runs, pass 2 gets the hit/miss guidance. The
  // write probe passes its own clause last.
  function composeMessages(capabilityClause: string, srcs: AnySource[], extraClause?: string): ChatMessage[] {
    const systemMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT_BASE },
      { role: 'system', content: capabilityClause },
      { role: 'system', content: buildContextBlock(srcs) },
    ]
    if (extraClause) {
      systemMessages.push({ role: 'system', content: extraClause })
    }
    return [...systemMessages, ...historyMessages, { role: 'user', content: finalUserContent }]
  }

  /* ---------- 6b. Model routing ------------------------------------------ */
  // One model handles text and images alike. A caller-pinned model is honoured
  // only when it is a Claude id (older clients may still send a Mistral one);
  // "deep reasoning" raises the effort instead of switching model.
  const chatModel: string | undefined = input.model?.startsWith('claude-') ? input.model : undefined
  const chatEffort: EffortLevel | undefined = input.reasoning ? 'high' : undefined

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
        // Failure-soft: an empty vector makes `rankChunks` go BM25-only.
        const queryVectors = await embedTextsSoft([retrievalQuery], { inputType: 'query', userId, operation: 'embed_query' })
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

      // N8 — write-action pre-flight. When the user toggled `allowWrites`, run
      // a structured-output probe first to see if the model wants to propose a
      // note action. If it does, surface the proposed call to the client and
      // SKIP streaming text — we don't want the bubble to be
      // half-text-half-action. The client renders an approve/reject card and
      // posts to `/api/ai/chat/sessions/:id/tool-call/approve` to execute or
      // cancel.
      let toolCallEmitted = false
      if (allowWrites) {
        try {
          const probe = await claudeChat({
            messages: composeMessages(SYSTEM_PROMPT_WEB_OFF, sources, WRITE_PROBE_PROMPT),
            jsonSchema: WRITE_PROBE_SCHEMA,
            userId,
            operation: 'chat_tool_probe',
            ...(chatModel ? { model: chatModel } : {}),
            ...(chatEffort ? { effort: chatEffort } : {}),
          })
          const calls = toProposedCalls(probe.structured, input.workspaceId)
          if (calls.length > 0) {
            send({ type: 'tool_call_pending', calls })
            // Place a short sentence in the assistant bubble so the user
            // sees something coherent instead of an empty message.
            const message = (probe.structured as { message?: unknown }).message
            const placeholder = typeof message === 'string' && message.trim().length > 0
              ? message.trim()
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
        // Two-pass, notes-first web policy:
        //   Pass 1 — answer from the notes alone. If the model decides the notes
        //            don't hold the answer it emits NO_NOTES_SENTINEL (intercepted,
        //            never shown).
        //   Pass 2 — only when pass 1 signalled (or the toggle forced it): run a
        //            web search, then answer from the enriched CONTEXT.
        // So the web fires automatically only when the notes come up short —
        // no manual toggle, no off-topic results dragged into a grounded answer.

        const streamOpts = {
          userId,
          operation: 'chat_stream',
          ...(chatModel ? { model: chatModel } : {}),
          ...(chatEffort ? { effort: chatEffort } : {}),
        }

        // Stream a message list straight through. Returns false when the
        // Claude call errored (an error frame was already sent).
        const streamAnswer = async (msgs: ChatMessage[]): Promise<boolean> => {
          try {
            for await (const text of claudeChatStream({ messages: msgs, ...streamOpts })) {
              collected += text
              send({ type: 'delta', text })
            }
            return true
          }
          catch (err) {
            errored = true
            const detail = (err as { data?: { detail?: string }, message?: string }).data?.detail
              ?? (err as Error).message
              ?? 'unknown error'
            send({ type: 'error', error: 'claude_failed', detail })
            return false
          }
        }

        // Pass 1: notes-only answer. Buffer the leading tokens so a bare
        // NO_NOTES_SENTINEL is intercepted (not shown) and turned into a web
        // escalation. Returns 'needWeb' to escalate, 'answered' when the notes
        // answer was streamed, 'error' on failure.
        const answerFromNotes = async (msgs: ChatMessage[]): Promise<'answered' | 'needWeb' | 'error'> => {
          let buffer = ''
          let decided = false
          try {
            for await (const text of claudeChatStream({ messages: msgs, ...streamOpts })) {
              if (decided) {
                collected += text
                send({ type: 'delta', text })
                continue
              }
              buffer += text
              const compact = buffer.replace(/\s/g, '')
              // Still ambiguous: the buffer could yet grow into the sentinel.
              if (compact.length < NO_NOTES_SENTINEL.length && NO_NOTES_SENTINEL.startsWith(compact)) continue
              if (buffer.trim().startsWith(NO_NOTES_SENTINEL)) return 'needWeb'
              decided = true
              collected += buffer
              send({ type: 'delta', text: buffer })
              buffer = ''
            }
            // Stream ended while still buffering (answer shorter than the sentinel).
            if (!decided) {
              if (buffer.trim().startsWith(NO_NOTES_SENTINEL)) return 'needWeb'
              if (buffer.length > 0) {
                collected += buffer
                send({ type: 'delta', text: buffer })
              }
            }
            return 'answered'
          }
          catch (err) {
            errored = true
            const detail = (err as { data?: { detail?: string }, message?: string }).data?.detail
              ?? (err as Error).message
              ?? 'unknown error'
            send({ type: 'error', error: 'claude_failed', detail })
            return 'error'
          }
        }

        // Run Tavily (search + deep-extract) and fold the hits into `sources`.
        const runWebSearch = async (q: string): Promise<void> => {
          webUsed = true
          send({ type: 'step', step: 'web', status: 'running', query: truncate(q, 200) })

          const searchResult = await tavilySearch(q, { maxResults: WEB_MAX_SOURCES })
          webDebug = searchResult.debug

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

          send({
            type: 'step',
            step: 'web',
            status: 'done',
            query: truncate(q, 200),
            count: webSources.length,
            sources: webSources.map(s => ({ title: s.title, url: s.url })),
          })
        }

        let needWeb = false
        if (!webEnabled) {
          // No web configured — single notes-only answer (no escalation path).
          await streamAnswer(composeMessages(SYSTEM_PROMPT_WEB_OFF, sources))
        }
        else if (forceWeb) {
          // User forced the web — skip the notes-only pass, search straight away.
          needWeb = true
        }
        else {
          // Notes-first: answer from notes; escalate only if the model signals it.
          const verdict = await answerFromNotes(composeMessages(SYSTEM_PROMPT_NOTES_FIRST, sources))
          needWeb = verdict === 'needWeb'
        }

        if (needWeb && !errored) {
          await runWebSearch(retrievalQuery)
          const clause = webSources.length > 0 ? SYSTEM_PROMPT_WEB_ON_HIT : SYSTEM_PROMPT_WEB_ON_MISS
          await streamAnswer(composeMessages(clause, sources))
        }
      }

      // ---- Post-stream refinement -----------------------------------------
      const cited = extractCitations(collected)
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
      const effectiveModel = getClaudeModel(chatModel)
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
        temperature: null,
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
