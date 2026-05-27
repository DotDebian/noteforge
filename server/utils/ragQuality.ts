/**
 * Chat RAG quality telemetry — per-turn record of retrieval health.
 *
 * `rerankScoreAvg` is stored as text because the schema column is TEXT
 * (admin queries can `CAST` if needed; keeps the precision we got from the
 * reranker without an extra REAL column).
 *
 * Fire-and-forget.
 */
import { useDb } from '~/server/database/client'
import { ragQualityLogs } from '~/server/database/schema'

export function logRagQuality(opts: {
  sessionId?: number
  userId: number
  chunksReturned: number
  rerankScoreAvg?: number
  citationsEmitted: number
  hasCitation: boolean
  rewriterUsed: boolean
  rerankerUsed: boolean
  latencyMs: number
}): void {
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(ragQualityLogs).values({
        sessionId: opts.sessionId ?? null,
        userId: opts.userId,
        chunksReturned: opts.chunksReturned,
        rerankScoreAvg: opts.rerankScoreAvg != null ? String(opts.rerankScoreAvg) : null,
        citationsEmitted: opts.citationsEmitted,
        hasCitation: opts.hasCitation,
        rewriterUsed: opts.rewriterUsed,
        rerankerUsed: opts.rerankerUsed,
        latencyMs: opts.latencyMs,
      })
    }
    catch { /* swallow */ }
  })
}
