/**
 * GET /api/admin/rag-quality — analytics over `rag_quality_logs` for the last
 * 30 days. Returns aggregate stat cards, per-day breakdown, and the 50 most
 * recent turns with user email lookup.
 */
import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const WINDOW_DAYS = 30

export interface RagQualityStats {
  totalChats: number
  avgChunksReturned: number
  avgRerankScore: number
  avgCitations: number
  pctHasCitation: number
  pctRewriterUsed: number
  pctRerankerUsed: number
  latencyP50: number
  latencyP95: number
}

export interface RagQualityDayRow {
  day: string
  count: number
  pctHasCitation: number
}

export interface RagQualityRecentRow {
  id: number
  createdAt: string
  userEmail: string | null
  chunksReturned: number
  citationsEmitted: number
  rerankAvg: number | null
  latencyMs: number | null
  hasCitation: boolean
}

export interface RagQualityResponse {
  windowDays: number
  stats: RagQualityStats
  perDay: RagQualityDayRow[]
  recent: RagQualityRecentRow[]
}

interface AggregateRow {
  total: number
  avgChunks: number | null
  avgRerank: number | null
  avgCitations: number | null
  hasCitationCount: number
  rewriterCount: number
  rerankerCount: number
}

interface PerDayRow {
  day: string
  cnt: number
  hasCitationCnt: number
}

interface LatencyRow {
  latencyMs: number
}

interface RecentRawRow {
  id: number
  createdAt: number
  userEmail: string | null
  chunksReturned: number
  citationsEmitted: number
  rerankAvg: number | null
  latencyMs: number | null
  hasCitation: number
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))
  return sortedAsc[idx] ?? 0
}

export default defineEventHandler(async (event): Promise<RagQualityResponse> => {
  await requireAdmin(event)
  const db = getRawDb()

  const aggregate = db.prepare(
    `SELECT count(*) AS total,
            avg(chunks_returned) AS avgChunks,
            avg(CAST(rerank_score_avg AS REAL)) AS avgRerank,
            avg(citations_emitted) AS avgCitations,
            sum(CASE WHEN has_citation = 1 THEN 1 ELSE 0 END) AS hasCitationCount,
            sum(CASE WHEN rewriter_used = 1 THEN 1 ELSE 0 END) AS rewriterCount,
            sum(CASE WHEN reranker_used = 1 THEN 1 ELSE 0 END) AS rerankerCount
     FROM rag_quality_logs
     WHERE created_at >= unixepoch('now', '-${WINDOW_DAYS} days')`,
  ).get() as AggregateRow

  const total = aggregate.total ?? 0

  const perDayRaw = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day,
            count(*) AS cnt,
            sum(CASE WHEN has_citation = 1 THEN 1 ELSE 0 END) AS hasCitationCnt
     FROM rag_quality_logs
     WHERE created_at >= unixepoch('now', '-${WINDOW_DAYS} days')
     GROUP BY day
     ORDER BY day`,
  ).all() as PerDayRow[]

  const latencyRows = db.prepare(
    `SELECT latency_ms AS latencyMs
     FROM rag_quality_logs
     WHERE latency_ms IS NOT NULL
       AND created_at >= unixepoch('now', '-${WINDOW_DAYS} days')`,
  ).all() as LatencyRow[]

  const latencies = latencyRows.map(r => r.latencyMs).sort((a, b) => a - b)

  const recentRaw = db.prepare(
    `SELECT r.id,
            r.created_at AS createdAt,
            u.email AS userEmail,
            r.chunks_returned AS chunksReturned,
            r.citations_emitted AS citationsEmitted,
            CAST(r.rerank_score_avg AS REAL) AS rerankAvg,
            r.latency_ms AS latencyMs,
            r.has_citation AS hasCitation
     FROM rag_quality_logs r
     LEFT JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC
     LIMIT 50`,
  ).all() as RecentRawRow[]

  const stats: RagQualityStats = {
    totalChats: total,
    avgChunksReturned: aggregate.avgChunks ?? 0,
    avgRerankScore: aggregate.avgRerank ?? 0,
    avgCitations: aggregate.avgCitations ?? 0,
    pctHasCitation: total > 0 ? (aggregate.hasCitationCount ?? 0) / total : 0,
    pctRewriterUsed: total > 0 ? (aggregate.rewriterCount ?? 0) / total : 0,
    pctRerankerUsed: total > 0 ? (aggregate.rerankerCount ?? 0) / total : 0,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
  }

  const perDay: RagQualityDayRow[] = perDayRaw.map(r => ({
    day: r.day,
    count: r.cnt,
    pctHasCitation: r.cnt > 0 ? r.hasCitationCnt / r.cnt : 0,
  }))

  const recent: RagQualityRecentRow[] = recentRaw.map(r => ({
    id: r.id,
    createdAt: new Date(r.createdAt * 1000).toISOString(),
    userEmail: r.userEmail,
    chunksReturned: r.chunksReturned,
    citationsEmitted: r.citationsEmitted,
    rerankAvg: r.rerankAvg,
    latencyMs: r.latencyMs,
    hasCitation: r.hasCitation === 1,
  }))

  return {
    windowDays: WINDOW_DAYS,
    stats,
    perDay,
    recent,
  }
})
