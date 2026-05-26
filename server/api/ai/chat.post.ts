import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody, setHeader, setResponseStatus } from 'h3'
import { useDb } from '~/server/database/client'
import {
  chatMessages,
  chatSessions,
  documents,
} from '~/server/database/schema'
import { assertDocumentAccess, assertFolderAccess, assertWorkspaceAccess } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { getDek } from '~/server/utils/dek'
import {
  decryptChatMessageContent,
  decryptDocument,
  encryptChatMessageContent,
  encryptChatSessionTitle,
  encryptChatSources,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'
import { mistralChatStream, mistralEmbed, type MistralMessage } from '~/server/utils/mistral'
import { bestSentence } from '~/server/utils/best-sentence'
import { extractCitations } from '~/server/utils/citations'
import { deriveSessionTitle } from '~/server/utils/chat-title'
import { applyRateLimit } from '~/server/utils/rate-limit'
import {
  SEARCH_SNIPPET_MAX,
  SEARCH_TOP_K,
  rankChunks,
} from '~/server/utils/search'
import { rerankChunks } from '~/server/utils/rerank'
import { rewriteQuery } from '~/server/utils/query-rewrite'

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const HISTORY_MAX = 10
const SNIPPET_MAX = 320           // prompt context: per-chunk cap shown to Mistral
const SOURCE_SNIPPET_MAX = SEARCH_SNIPPET_MAX
/** First-stage candidate pool size before the LLM reranker trims. */
const RERANK_POOL = 18

/* -------------------------------------------------------------------------- */
/*  Input                                                                      */
/* -------------------------------------------------------------------------- */

const Body = z.object({
  workspaceId: z.number().int().positive(),
  sessionId: z.number().int().positive().optional(),
  scopeFolderId: z.number().int().positive().nullable().optional(),
  scopeDocId: z.number().int().positive().nullable().optional(),
  message: z.string().trim().min(1).max(8000),
})

interface SourceRef {
  docId: number
  chunkIdx: number
  snippet: string
  title: string
}

interface RefinedSource extends SourceRef {
  /** Citation number as it appears in the assistant text ([#N]). */
  citation: number
  /** The single sentence inside the chunk that best matches the answer. */
  highlight: string
}

/* -------------------------------------------------------------------------- */
/*  Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are NoteForge Chat, a focused assistant for the user's own notes.

You will be given retrieved snippets from the user's notes inside a "CONTEXT"
section. Treat them as the primary source of truth. When the answer is
supported by the context, cite the relevant note inline like [#1], [#2] using
the numeric markers shown next to each snippet. If the context does not
contain the answer, say so plainly and offer to look elsewhere. Be concise
and reply in the user's language.`

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= n) return cleaned
  return `${cleaned.slice(0, n - 1).trimEnd()}…`
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/* -------------------------------------------------------------------------- */
/*  Handler                                                                    */
/* -------------------------------------------------------------------------- */

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  applyRateLimit(event, user.id, 'chat')
  const input = await readValidatedBody(event, Body.parse)

  await assertWorkspaceAccess(event, input.workspaceId)

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

  /* ---------- 2. Persist the user message -------------------------------- */
  await db.insert(chatMessages).values({
    sessionId,
    role: 'user',
    content: encryptChatMessageContent(input.message, dek),
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
  // The rewriter resolves pronouns / anaphora against prior turns so the
  // embedding step doesn't blow on follow-ups like "et le second point ?".
  // Failures fall back to the original message inside the helper.
  const retrievalQuery = await rewriteQuery(historyMessages, input.message)

  /* ---------- 5. Retrieve context ---------------------------------------- */
  const queryVectors = await mistralEmbed([retrievalQuery])
  const queryVec = queryVectors[0] ?? []

  // Candidate docs in the workspace, optionally constrained to a folder or
  // a single document (doc scope). Trashed (soft-deleted) docs are skipped —
  // they must not contribute to chat retrieval.
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
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(docFilters)

  const titleByDoc = new Map(
    candidateDocs.map(d => [d.id, decryptDocument({ title: d.title }, dek).title!] as const),
  )
  const candidateDocIds = candidateDocs.map(d => d.id)

  const sources: SourceRef[] = []
  if (candidateDocIds.length > 0) {
    // Hybrid first stage (vec + FTS5, RRF-fused). Oversampled to RERANK_POOL
    // with NO per-doc cap so the reranker has diverse material to work with.
    // The cap is applied after the rerank step below.
    const scored = await rankChunks(candidateDocIds, queryVec, {
      perDocCap: Number.POSITIVE_INFINITY,
      topK: RERANK_POOL,
      queryText: retrievalQuery,
    }, dek)

    // Second stage: Mistral reranker. Reorders the pool against the rewritten
    // query and keeps roughly 2× SEARCH_TOP_K so the per-doc cap below has
    // something to pick from.
    const reranked = await rerankChunks(retrievalQuery, scored, SEARCH_TOP_K * 2)

    // Apply the per-doc cap (workspace mode only) and trim to SEARCH_TOP_K.
    const finalCap = effectiveDocId != null ? Number.POSITIVE_INFINITY : 2
    const seenPerDoc = new Map<number, number>()
    for (const hit of reranked) {
      if (sources.length >= SEARCH_TOP_K) break
      const used = seenPerDoc.get(hit.docId) ?? 0
      if (used >= finalCap) continue
      seenPerDoc.set(hit.docId, used + 1)
      sources.push({
        docId: hit.docId,
        chunkIdx: hit.idx,
        snippet: truncate(hit.text, SOURCE_SNIPPET_MAX),
        title: titleByDoc.get(hit.docId) ?? 'Untitled',
      })
    }
  }

  /* ---------- 6. Build the prompt ---------------------------------------- */
  let contextBlock = ''
  if (sources.length > 0) {
    const lines: string[] = ['CONTEXT (retrieved from the user\'s notes):']
    sources.forEach((s, i) => {
      lines.push(`[#${i + 1}] ${s.title} — ${truncate(s.snippet, SNIPPET_MAX)}`)
    })
    contextBlock = lines.join('\n')
  }
  else {
    contextBlock = 'CONTEXT: (no notes matched this query)'
  }

  const messages: MistralMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextBlock },
    ...historyMessages,
    { role: 'user', content: input.message },
  ]

  /* ---------- 7. Stream the response ------------------------------------- */
  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setHeader(event, 'Connection', 'keep-alive')
  setHeader(event, 'X-Accel-Buffering', 'no')
  setResponseStatus(event, 200)

  const finalSessionId = sessionId

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (obj: unknown) => controller.enqueue(enc.encode(sseFrame(obj)))
      let collected = ''
      let errored = false

      // Emit the session id early. We deliberately do NOT emit `sources` yet —
      // we wait until the model has produced its answer so we can filter to
      // only those it actually cited (and surface the supporting sentence
      // inside each chunk).
      send({ type: 'session', sessionId: finalSessionId })

      try {
        for await (const delta of mistralChatStream({ messages, temperature: 0.2 })) {
          collected += delta
          send({ type: 'delta', text: delta })
        }
      }
      catch (err) {
        errored = true
        const detail = (err as { data?: { detail?: string }, message?: string }).data?.detail
          ?? (err as Error).message
          ?? 'unknown error'
        send({ type: 'error', error: 'mistral_failed', detail })
      }

      // ---- Post-stream refinement -----------------------------------------
      // Parse the citation markers `[#N]` from the answer, filter the
      // retrieved sources to those actually used, and compute a per-source
      // sentence-level highlight against the answer text.
      const cited = extractCitations(collected)
      const refined: RefinedSource[] = []
      for (let i = 0; i < sources.length; i++) {
        const n = i + 1
        if (!cited.has(n)) continue
        const s = sources[i]
        if (!s) continue
        refined.push({
          ...s,
          citation: n,
          highlight: bestSentence(s.snippet, collected),
        })
      }

      const refinedForClient = refined.map(s => ({
        docId: s.docId,
        chunkIdx: s.chunkIdx,
        title: s.title,
        snippet: s.snippet,
        highlight: s.highlight,
        citation: s.citation,
      }))

      // Persist the assistant message with the refined (cited-only) sources.
      // The full answer text + every snippet/highlight gets encrypted at
      // rest with the per-user DEK.
      try {
        await useDb().insert(chatMessages).values({
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
            })),
            dek,
          ),
        })
      }
      catch (err) {
        console.error('[ai/chat] failed to persist assistant message', err)
      }

      if (!errored) {
        send({
          type: 'done',
          sessionId: finalSessionId,
          sources: refinedForClient,
        })
      }
      controller.close()
    },
  })

  return stream
})
