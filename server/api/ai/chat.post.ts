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
  encryptChatMessageContent,
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

/**
 * Heuristic intent detector: did the user just ask us to look online?
 * Matches French / English phrasings so we auto-enable web search for that
 * single turn even when the toggle is off. False-positive cost is one
 * web_search call (~$0.002); false-negative cost is the bad UX where the
 * user keeps asking and we keep refusing. Tilt toward catching too much.
 *
 * The detector fires when ANY of these are true:
 *  - the message mentions web/internet/google/en ligne (even as a single
 *    word — "Web ?" / "internet ?" / "google" is enough),
 *  - the message contains a search verb (cherche/recherche/search/look up…),
 *  - the message is a short affirmative ("oui", "vas-y", "ok", "yes")
 *    AND the prior assistant turn offered to look elsewhere.
 */
function asksForWebSearch(message: string, lastAssistantText: string): boolean {
  const m = message.toLowerCase().trim()
  if (m.length === 0) return false

  // 1. Any explicit mention of the web / a search engine — strongest signal.
  //    Word-boundary so "webhook" doesn't trip it.
  if (/\b(web|internet|en[\s-]?ligne|online|google|googler|duckduckgo|bing)\b/.test(m)) {
    return true
  }

  // 2. Search verbs (cherche / recherche / search / look up / fais une recherche).
  const verbs = [
    /\b(cherche|cherches|recherche|recherches|chercher|rechercher)\b/,
    /\b(regarde|regardes|consulte|consultes|trouve|trouves)\b/,
    /\b(search|searches|searching|google|googled|look(\s+it)?\s+up)\b/,
    /\bfais\s+une\s+recherche\b/,
    /\bbrowse(s|d)?\b/,
  ]
  for (const re of verbs) {
    if (re.test(m)) return true
  }

  // 3. Short affirmative right after the assistant offered to look elsewhere.
  const isShortAffirmative = /^(ok|oui|yes|vas[- ]?y|go(\s+ahead)?|please|s[iy]l? te pla[iî]t|stp|d'accord|sure)\b/.test(m)
    && m.length <= 40
  if (isShortAffirmative) {
    const lat = lastAssistantText.toLowerCase()
    if (lat.length > 0 && (
      lat.includes('ailleurs')
      || lat.includes('online')
      || lat.includes('elsewhere')
      || lat.includes('web')
      || lat.includes('chercher')
      || lat.includes('en ligne')
      || lat.includes('cette information')
    )) {
      return true
    }
  }
  return false
}

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
/*  Web fallback (best-effort tool-call parsing)                               */
/* -------------------------------------------------------------------------- */

interface WebHit {
  title: string
  url: string
  snippet: string
}

/**
 * Run a one-shot non-streaming Mistral call with the `web_search` tool to
 * collect a small set of URLs the model thinks are relevant to the question.
 * We DON'T try to parse the streaming tool deltas — this side-call is the
 * cheap, safe way to surface web sources alongside note ones.
 *
 * Failure-soft: returns an empty array on any error.
 */
/**
 * Pick a model that Mistral actually supports `web_search` on. Small models
 * are silently ignored. `mistral-medium-latest` is the cheapest tier that
 * accepts the built-in connector.
 */
function coerceWebSearchModel(baseModel: string): string {
  const m = baseModel.toLowerCase()
  if (m.includes('small') || m.includes('tiny') || m.includes('ministral')) {
    return 'mistral-medium-latest'
  }
  // Magistral/reasoning + vision models stay; they generally support the connector.
  return baseModel
}

interface ConversationsResponse {
  conversation_id?: string
  /** Some response shapes carry top-level references alongside outputs. */
  references?: Array<{ url?: string, title?: string, snippet?: string }>
  outputs?: Array<{
    type?: string                      // 'message.output' | 'tool.execution' | 'function.result' …
    role?: string
    name?: string                       // tool name (e.g. 'web_search')
    function?: string                   // legacy alias for `name`
    content?:
      | string
      | Array<{
        type?: string
        text?: string
        reference?: { url?: string, title?: string, snippet?: string, source?: string }
        url?: string
        title?: string
        snippet?: string
      }>
    references?: Array<{ url?: string, title?: string, snippet?: string }>
    /** Observed Mistral conversations shape: `info.result` is a JSON-encoded
     *  STRING of an object keyed by stringified index ("0","1","2") containing
     *  `{ url, title, description, snippets[] }` per hit. */
    info?: { result?: string | unknown }
    /** Alt shapes seen in other Mistral connectors. */
    output?:
      | { results?: Array<{ url?: string, title?: string, snippet?: string, description?: string }> }
      | Array<{ url?: string, title?: string, snippet?: string, description?: string }>
      | string
    results?: Array<{ url?: string, title?: string, snippet?: string, description?: string }>
  }>
}

/**
 * One-shot web search via Mistral's **Conversations API** (`/v1/conversations`).
 *
 * Why this endpoint specifically: the built-in `web_search` connector is NOT
 * exposed on `/v1/chat/completions` — that endpoint only accepts user-defined
 * `type: "function"` tools. Sending `tools: [{type:"web_search"}]` there is
 * silently ignored, which is why the previous implementation always returned
 * zero hits. The Conversations API IS the documented surface for built-in
 * connectors. Each call starts a fresh conversation; we ignore the
 * conversation_id (no state, no follow-ups). Only the query leaves NoteForge,
 * matching the at-rest threat model (notes never travel here).
 *
 * Failure-soft: returns `{ hits: [], debug }` on any error. The `debug`
 * payload is surfaced to the client so the user can paste it back when
 * web search misbehaves.
 */
async function gatherWebSources(
  question: string,
  userId: number,
  baseModel: string,
): Promise<{ hits: WebHit[], debug: { endpoint: string, model: string, status: number | null, error?: string, rawSample?: string } }> {
  const model = coerceWebSearchModel(baseModel)
  const endpoint = 'https://api.mistral.ai/v1/conversations'
  const debug: { endpoint: string, model: string, status: number | null, error?: string, rawSample?: string, parserVersion?: string } = {
    endpoint,
    model,
    status: null,
    // Bumped whenever the parser logic changes — gives us a quick "are my edits
    // live?" signal when reading a pasted debug blob.
    parserVersion: 'v4-info-result-2026-05-28',
  }

  // Resolve API key without crashing if it's missing.
  const cfg = useRuntimeConfig()
  const apiKey = cfg.mistralApiKey as string | undefined
  if (!apiKey || typeof apiKey !== 'string') {
    debug.error = 'MISTRAL_API_KEY missing'
    return { hits: [], debug }
  }

  const start = Date.now()
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        model,
        inputs: question,
        tools: [{ type: 'web_search' }],
        // No system prompt — the connector reads the user input directly.
        // No stream/store flags — one-shot, throwaway conversation.
      }),
    })
  }
  catch (err) {
    debug.error = `network: ${(err as Error).message ?? 'unknown'}`
    console.warn('[ai/chat] web fallback network error:', debug.error)
    return { hits: [], debug }
  }

  debug.status = res.status

  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch { /* noop */ }
    debug.error = body ? `HTTP ${res.status}: ${body.slice(0, 240)}` : `HTTP ${res.status}`
    console.warn(`[ai/chat] web fallback ${endpoint} ${res.status} (${Date.now() - start}ms):`, body.slice(0, 500))
    return { hits: [], debug }
  }

  let json: ConversationsResponse
  try {
    json = (await res.json()) as ConversationsResponse
  }
  catch (err) {
    debug.error = `parse: ${(err as Error).message ?? 'unknown'}`
    return { hits: [], debug }
  }

  // Snapshot a trimmed sample of the raw response — invaluable for diagnosing
  // shape mismatches. 4000 chars covers a typical conversations response
  // with the message.output + tool.execution outputs.
  try {
    debug.rawSample = JSON.stringify(json).slice(0, 4000)
  }
  catch { /* circular — shouldn't happen on plain JSON, ignore */ }

  // Full-fat diagnostic dump to the server console — only when the operator
  // explicitly enables it via DEBUG_WEB_SEARCH=1. Useful when the trimmed
  // sample isn't enough to reverse-engineer Mistral's exact response shape.
  if (process.env.DEBUG_WEB_SEARCH === '1') {
    try {
      console.log('[ai/chat] web_search raw response:\n', JSON.stringify(json, null, 2))
    }
    catch { /* noop */ }
  }

  const hits: WebHit[] = []
  const seenUrls = new Set<string>()

  const tryAddHit = (url: unknown, title: unknown, snippet: unknown) => {
    if (typeof url !== 'string' || url.length === 0) return
    if (seenUrls.has(url)) return
    if (hits.length >= WEB_MAX_SOURCES) return
    seenUrls.add(url)
    hits.push({
      title: typeof title === 'string' && title.length > 0 ? title : safeHost(url),
      url,
      snippet: typeof snippet === 'string' ? snippet : '',
    })
  }

  let synthesizedAnswer = ''

  // 0) Top-level references (some shapes put them here, outside outputs[]).
  if (Array.isArray(json.references)) {
    for (const r of json.references) tryAddHit(r.url, r.title, r.snippet)
  }

  for (const out of json.outputs ?? []) {
    if (hits.length >= WEB_MAX_SOURCES) break

    // 1) message.output level references
    if (Array.isArray(out.references)) {
      for (const r of out.references) tryAddHit(r.url, r.title, r.snippet)
    }

    // 2) Array-form content with embedded ReferenceChunks
    if (Array.isArray(out.content)) {
      for (const part of out.content) {
        if (!part || typeof part !== 'object') continue
        const ref = part.reference
        const url = ref?.url ?? part.url
        tryAddHit(url, ref?.title ?? part.title, ref?.snippet ?? part.snippet)
      }
    }

    const isToolExec = typeof out.type === 'string' && (
      out.type.includes('tool')
      || out.type.includes('function')
      || out.type === 'tool.execution'
    )

    // 3a) tool.execution with `info.result` — the actual observed Mistral
    //     web_search shape. `info.result` is a JSON-encoded STRING of an
    //     object keyed by stringified index ("0","1","2") with rich
    //     {url,title,description,snippets[]} per hit. THIS is where the
    //     content lives — empty snippets here means the downstream model
    //     gets no usable context and ends up saying "I don't have this info".
    if (isToolExec && out.info && typeof out.info === 'object') {
      const raw = (out.info as { result?: unknown }).result
      let parsed: unknown = raw
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw) }
        catch { parsed = null }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Sort by numeric key so the order matches Mistral's ranking.
        const entries = Object.entries(parsed as Record<string, unknown>)
          .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
        for (const [, entry] of entries) {
          if (!entry || typeof entry !== 'object') continue
          const e = entry as {
            url?: unknown
            title?: unknown
            description?: unknown
            snippet?: unknown
            snippets?: unknown
          }
          // Build a rich snippet: description + first 2 snippet strings,
          // joined with em-dashes so the downstream model has actual facts
          // to cite from instead of an empty placeholder.
          const parts: string[] = []
          if (typeof e.description === 'string' && e.description.length > 0) {
            parts.push(e.description)
          }
          if (Array.isArray(e.snippets)) {
            let added = 0
            for (const s of e.snippets) {
              if (added >= 2) break
              if (typeof s === 'string' && s.length > 0) {
                parts.push(s)
                added++
              }
            }
          }
          else if (typeof e.snippet === 'string' && e.snippet.length > 0) {
            parts.push(e.snippet)
          }
          tryAddHit(e.url, e.title, parts.join(' — '))
          if (hits.length >= WEB_MAX_SOURCES) break
        }
      }
    }

    // 3b) tool.execution outputs (other documented shapes for built-in
    //     connectors). Shapes vary:
    //       { type: 'tool.execution', name: 'web_search', output: { results: [...] } }
    //       { type: 'tool.execution', output: [ {url,title,snippet}, ... ] }
    //       { type: 'tool.execution', results: [...] }
    if (isToolExec || Array.isArray(out.results)) {
      // Pull the array out of whichever shape is present.
      let arr: Array<{ url?: string, title?: string, snippet?: string, description?: string }> = []
      if (Array.isArray(out.results)) arr = out.results
      else if (Array.isArray(out.output)) arr = out.output
      else if (out.output && typeof out.output === 'object' && 'results' in out.output && Array.isArray((out.output as { results?: unknown }).results)) {
        arr = (out.output as { results: Array<{ url?: string, title?: string, snippet?: string, description?: string }> }).results
      }
      for (const r of arr) {
        tryAddHit(r.url, r.title, r.snippet ?? r.description)
      }
    }

    // 4) Capture any synthesized text — used as a last-resort fallback below
    //    so the user at least sees Mistral's own write-up when no structured
    //    refs are surfaced.
    if (typeof out.content === 'string' && out.content.length > 0) {
      synthesizedAnswer += (synthesizedAnswer.length > 0 ? '\n\n' : '') + out.content
    }
  }

  // 5) Fallback A — pull markdown links / bare URLs from the synthesized text.
  //    Mistral often inlines `[Source title](https://…)` after the answer.
  if (hits.length < WEB_MAX_SOURCES && synthesizedAnswer.length > 0) {
    const mdLink = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g
    for (const m of synthesizedAnswer.matchAll(mdLink)) {
      tryAddHit(m[2], m[1], '')
      if (hits.length >= WEB_MAX_SOURCES) break
    }
  }
  if (hits.length < WEB_MAX_SOURCES && synthesizedAnswer.length > 0) {
    const bareUrl = /https?:\/\/[^\s)<>"]+/g
    for (const m of synthesizedAnswer.matchAll(bareUrl)) {
      tryAddHit(m[0], '', '')
      if (hits.length >= WEB_MAX_SOURCES) break
    }
  }

  // 6) Fallback B — no structured refs AND no URLs in the text, but Mistral
  //    DID write a synthesized answer. Surface it as a single pseudo-source
  //    so the user actually sees Mistral's findings instead of "no results".
  if (hits.length === 0 && synthesizedAnswer.length > 0) {
    hits.push({
      title: 'Mistral web synthesis',
      url: 'https://mistral.ai/',
      snippet: synthesizedAnswer.slice(0, 600),
    })
    debug.error = 'no structured refs — used synthesized text as fallback source'
  }

  if (hits.length === 0) {
    debug.error = debug.error ?? 'no references and no synthesized text'
  }
  return { hits, debug }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname }
  catch { return url.slice(0, 40) }
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

  /* ---------- 4. Rewrite the retrieval query ----------------------------- */
  const rewriterUsed = historyMessages.length > 0
  const retrievalQuery = await rewriteQuery(historyMessages, input.message, user.id)

  /* ---------- 5. Retrieve context ---------------------------------------- */
  const queryVectors = await mistralEmbed([retrievalQuery], { userId: user.id, operation: 'embed_query' })
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

  const noteSources: SourceRef[] = []
  let rerankerUsed = false
  let rerankScoreAvg: number | undefined
  if (candidateDocIds.length > 0) {
    const scored = await rankChunks(candidateDocIds, queryVec, {
      perDocCap: Number.POSITIVE_INFINITY,
      topK: RERANK_POOL,
      queryText: retrievalQuery,
    }, workspaceKey)

    const rerankerSkipped = scored.length <= 1 || getRerankerCircuitOpen()
    rerankerUsed = !rerankerSkipped
    const reranked = await rerankChunks(retrievalQuery, scored, SEARCH_TOP_K * 2, user.id)
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

  /* ---------- 5b. Web fallback (Wave 2 / N5) ----------------------------- */
  // The toggle is the user's persistent opt-in. We ALSO auto-detect natural-
  // language intent ("cherche sur le web", "vas-y", "search the web") so
  // users don't have to click a checkbox to get the behaviour they're asking
  // for. `webAutoTriggered` is forwarded to the client so the UI can flash
  // a small "web search auto-enabled for this turn" badge.
  const lastAssistantTurn = historyMessages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant')
  const lastAssistantText = typeof lastAssistantTurn?.content === 'string'
    ? lastAssistantTurn.content
    : ''
  const webAutoTriggered = !input.webFallback && asksForWebSearch(input.message, lastAssistantText)
  const useWebSearch = input.webFallback || webAutoTriggered

  const webSources: WebSourceRef[] = []
  let webDebug: { endpoint: string, model: string, status: number | null, error?: string, rawSample?: string } | null = null
  if (useWebSearch) {
    // Use the rewritten retrieval query — it resolves pronouns/anaphora from
    // history ("Web ?" → "qui est l'éditeur de Timify, sur le web ?") so the
    // web tool isn't given a meaningless one-word query.
    const result = await gatherWebSources(retrievalQuery, user.id, input.model ?? 'mistral-medium-latest')
    webDebug = result.debug
    for (const h of result.hits) {
      webSources.push({
        docId: 0,
        chunkIdx: 0,
        snippet: truncate(h.snippet, SOURCE_SNIPPET_MAX),
        title: h.title,
        url: h.url,
      })
    }
  }

  const sources: AnySource[] = [...noteSources, ...webSources]

  /* ---------- 6. Build the prompt ---------------------------------------- */
  let contextBlock = ''
  if (sources.length > 0) {
    const lines: string[] = ['CONTEXT (retrieved from the user\'s notes and the web):']
    sources.forEach((s, i) => {
      const isWeb = 'url' in s
      const tag = isWeb ? 'Web' : 'Note'
      lines.push(`[#${i + 1}] (${tag}) ${s.title} — ${truncate(s.snippet, SNIPPET_MAX)}`)
    })
    contextBlock = lines.join('\n')
  }
  else {
    contextBlock = 'CONTEXT: (no notes matched this query)'
  }

  // The "real" user message — string when plain, array when an image was attached.
  const finalUserContent: MistralMessage['content'] = imageContentPart
    ? [
        { type: 'text', text: input.message },
        imageContentPart,
      ]
    : input.message

  // Assemble the system prompt: base policy + capability disclosure (so the
  // model never pretends to do background work it can't actually do) + the
  // retrieved CONTEXT block + optional tools clause.
  const capabilityClause = !useWebSearch
    ? SYSTEM_PROMPT_WEB_OFF
    : webSources.length > 0
      ? SYSTEM_PROMPT_WEB_ON_HIT
      : SYSTEM_PROMPT_WEB_ON_MISS
  const systemMessages: MistralMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT_BASE },
    { role: 'system', content: capabilityClause },
    { role: 'system', content: contextBlock },
  ]
  if (input.allowWrites) {
    systemMessages.push({ role: 'system', content: TOOLS_SYSTEM_PROMPT })
  }

  const messages: MistralMessage[] = [
    ...systemMessages,
    ...historyMessages,
    { role: 'user', content: finalUserContent },
  ]

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

  // Shape sources for the early `partial_sources` frame (N9). The client
  // renders these under the streaming assistant bubble while the model is
  // still talking; the `done` frame later replaces them with the cited list.
  const partialSourcesForClient = sources.map(s => ({
    docId: s.docId,
    chunkIdx: s.chunkIdx,
    title: s.title,
    snippet: s.snippet,
    ...('url' in s ? { kind: 'web' as const, url: s.url } : { kind: 'note' as const }),
    ...((s as SourceRef).docUpdatedAt !== undefined ? { docUpdatedAt: (s as SourceRef).docUpdatedAt } : {}),
  }))

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

      // Tell the client we auto-triggered web search for this turn so it can
      // surface a small "🌐 web search auto-enabled" badge under the bubble.
      if (webAutoTriggered) {
        send({ type: 'web_auto', hits: webSources.length })
      }

      // Per-turn meta for the debug panel: model, web search state,
      // retrieval query, scope. Trimmed so it's safe to log/copy.
      // `chatModel` may be undefined when the caller didn't override — in
      // that case Mistral falls through to `cfg.mistralChatModel`, which we
      // mirror here so the panel shows what actually ran.
      const effectiveModel = chatModel
        ?? (useRuntimeConfig().mistralChatModel as string | undefined)
        ?? 'mistral-medium-latest'
      send({
        type: 'meta',
        model: effectiveModel,
        webRequested: input.webFallback === true,
        webAuto: webAutoTriggered,
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
      })

      // N9 — emit the working source list early so the UI can render a
      // "searching X, Y, Z" hint while the model still types. We deliberately
      // ship the full retrieval (uncited yet) here; the `done` frame below
      // narrows it down to the truly cited subset.
      if (partialSourcesForClient.length > 0) {
        send({ type: 'partial_sources', sources: partialSourcesForClient })
      }

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
        try {
          for await (const ev of mistralChatStream({
            messages,
            temperature: chatTemperature,
            userId,
            operation: 'chat_stream',
            ...(chatModel ? { model: chatModel } : {}),
          })) {
            if (ev.kind === 'text') {
              collected += ev.text
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
          }
        }
        catch (err) {
          errored = true
          const detail = (err as { data?: { detail?: string }, message?: string }).data?.detail
            ?? (err as Error).message
            ?? 'unknown error'
          send({ type: 'error', error: 'mistral_failed', detail })
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
          snippet: s.snippet,
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
        // Follow-ups make no sense when we just emitted a tool-call card —
        // the user's next action is "approve / reject", not "ask follow-up".
        const followups = !toolCallEmitted && collected.trim().length > 0
          ? await generateFollowups(userMessage, collected, userId)
          : []

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
