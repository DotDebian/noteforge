/**
 * GET /api/ai/chat/messages/:id/debug
 *
 * Returns the RAG quality row most likely to correspond to the given
 * assistant message. Since `rag_quality_logs` doesn't carry a per-message
 * foreign key, we approximate the join by finding the row with matching
 * `sessionId` whose `createdAt` is closest in time to the message's
 * `createdAt` (within a 60-second window).
 *
 * Returns `null` when no row matches the window — used by the per-message
 * "🛈 debug" panel (Wave 3 / I5).
 *
 * Ownership: the message must live in a session owned by the caller.
 */
import { and, eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions, ragQualityLogs } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const WINDOW_SECONDS = 60

export interface ChatMessageDebug {
  chunksReturned: number
  citationsEmitted: number
  rerankScoreAvg: number | null
  hasCitation: boolean
  rewriterUsed: boolean
  rerankerUsed: boolean
  latencyMs: number | null
}

export default defineEventHandler(async (event): Promise<ChatMessageDebug | null> => {
  const user = await requireUser(event)
  const messageId = parseIdParam(event)

  const db = useDb()

  const [msg] = await db
    .select({
      id: chatMessages.id,
      sessionId: chatMessages.sessionId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1)

  if (!msg) throw createError({ statusCode: 404, statusMessage: 'Message not found' })

  const [session] = await db
    .select({ userId: chatSessions.userId })
    .from(chatSessions)
    .where(eq(chatSessions.id, msg.sessionId))
    .limit(1)

  if (!session) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  if (session.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  // Coerce both timestamps to unix-seconds for an apples-to-apples Math.abs.
  const msgTs = msg.createdAt instanceof Date
    ? Math.floor(msg.createdAt.getTime() / 1000)
    : Number(msg.createdAt ?? 0)

  // Scan all RAG rows for the session; in practice these are bounded by the
  // session length (small) — no need to push the time math into SQL.
  const rows = await db
    .select()
    .from(ragQualityLogs)
    .where(and(
      eq(ragQualityLogs.sessionId, msg.sessionId),
      eq(ragQualityLogs.userId, user.id),
    ))

  if (rows.length === 0) return null

  let best: typeof rows[number] | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const r of rows) {
    const ts = r.createdAt instanceof Date
      ? Math.floor(r.createdAt.getTime() / 1000)
      : Number(r.createdAt ?? 0)
    const delta = Math.abs(ts - msgTs)
    if (delta < bestDelta) {
      bestDelta = delta
      best = r
    }
  }

  if (!best || bestDelta > WINDOW_SECONDS) return null

  const rerankAvg = best.rerankScoreAvg != null && best.rerankScoreAvg.length > 0
    ? Number(best.rerankScoreAvg)
    : null

  return {
    chunksReturned: best.chunksReturned,
    citationsEmitted: best.citationsEmitted,
    rerankScoreAvg: Number.isFinite(rerankAvg) ? rerankAvg : null,
    hasCitation: best.hasCitation,
    rewriterUsed: best.rewriterUsed,
    rerankerUsed: best.rerankerUsed,
    latencyMs: best.latencyMs ?? null,
  }
})
