import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const Query = z.object({
  userId: z.coerce.number().int().positive().optional(),
  days: z.coerce.number().int().min(7).max(365).default(30),
})

interface DailyRow {
  day: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
interface ModelOpRow {
  model: string
  operation: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
interface UserRow {
  id: number
  email: string
  displayName: string | null
  totalTokens: number
  promptTokens: number
  completionTokens: number
}
interface LatencyRawRow {
  model: string
  latencyMs: number
}
interface ErrorRateRawRow {
  model: string
  total: number
  errors: number
}

export interface LatencyByModelRow {
  model: string
  p50: number
  p95: number
  count: number
}
export interface ErrorRateRow {
  model: string
  total: number
  errors: number
  success: number
  rate: number
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))
  return sortedAsc[idx] ?? 0
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { userId, days } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()

  let dailyRows: DailyRow[]
  let byModelOp: ModelOpRow[]
  let latencyRaw: LatencyRawRow[]
  let errorRateRaw: ErrorRateRawRow[]

  if (userId) {
    dailyRows = db.prepare(
      `SELECT date(created_at, 'unixepoch') AS day, model,
              sum(prompt_tokens) AS promptTokens,
              sum(completion_tokens) AS completionTokens,
              sum(total_tokens) AS totalTokens
       FROM ai_usage_logs
       WHERE created_at >= unixepoch('now', '-${days} days') AND user_id = ?
       GROUP BY day, model ORDER BY day, model`,
    ).all(userId) as DailyRow[]

    byModelOp = db.prepare(
      `SELECT model, operation,
              sum(prompt_tokens) AS promptTokens,
              sum(completion_tokens) AS completionTokens,
              sum(total_tokens) AS totalTokens
       FROM ai_usage_logs WHERE user_id = ?
       GROUP BY model, operation ORDER BY sum(total_tokens) DESC`,
    ).all(userId) as ModelOpRow[]

    latencyRaw = db.prepare(
      `SELECT model, latency_ms AS latencyMs
       FROM ai_usage_logs
       WHERE user_id = ?
         AND success = 1
         AND latency_ms IS NOT NULL
         AND created_at >= unixepoch('now', '-${days} days')`,
    ).all(userId) as LatencyRawRow[]

    errorRateRaw = db.prepare(
      `SELECT model,
              count(*) AS total,
              sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
       FROM ai_usage_logs
       WHERE user_id = ?
         AND created_at >= unixepoch('now', '-${days} days')
       GROUP BY model`,
    ).all(userId) as ErrorRateRawRow[]
  }
  else {
    dailyRows = db.prepare(
      `SELECT date(created_at, 'unixepoch') AS day, model,
              sum(prompt_tokens) AS promptTokens,
              sum(completion_tokens) AS completionTokens,
              sum(total_tokens) AS totalTokens
       FROM ai_usage_logs
       WHERE created_at >= unixepoch('now', '-${days} days')
       GROUP BY day, model ORDER BY day, model`,
    ).all() as DailyRow[]

    byModelOp = db.prepare(
      `SELECT model, operation,
              sum(prompt_tokens) AS promptTokens,
              sum(completion_tokens) AS completionTokens,
              sum(total_tokens) AS totalTokens
       FROM ai_usage_logs
       GROUP BY model, operation ORDER BY sum(total_tokens) DESC`,
    ).all() as ModelOpRow[]

    latencyRaw = db.prepare(
      `SELECT model, latency_ms AS latencyMs
       FROM ai_usage_logs
       WHERE success = 1
         AND latency_ms IS NOT NULL
         AND created_at >= unixepoch('now', '-${days} days')`,
    ).all() as LatencyRawRow[]

    errorRateRaw = db.prepare(
      `SELECT model,
              count(*) AS total,
              sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
       FROM ai_usage_logs
       WHERE created_at >= unixepoch('now', '-${days} days')
       GROUP BY model`,
    ).all() as ErrorRateRawRow[]
  }

  const users = db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName,
            sum(l.total_tokens) AS totalTokens,
            sum(l.prompt_tokens) AS promptTokens,
            sum(l.completion_tokens) AS completionTokens
     FROM ai_usage_logs l
     JOIN users u ON u.id = l.user_id
     GROUP BY l.user_id ORDER BY sum(l.total_tokens) DESC LIMIT 50`,
  ).all() as UserRow[]

  /* ---- Per-model p50 / p95 in JS (small datasets) ---- */
  const latencyMap = new Map<string, number[]>()
  for (const row of latencyRaw) {
    const arr = latencyMap.get(row.model) ?? []
    arr.push(row.latencyMs)
    latencyMap.set(row.model, arr)
  }
  const latencyByModel: LatencyByModelRow[] = []
  for (const [model, arr] of latencyMap.entries()) {
    arr.sort((a, b) => a - b)
    latencyByModel.push({
      model,
      p50: percentile(arr, 0.5),
      p95: percentile(arr, 0.95),
      count: arr.length,
    })
  }
  latencyByModel.sort((a, b) => b.count - a.count)

  const errorRateByModel: ErrorRateRow[] = errorRateRaw.map(r => ({
    model: r.model,
    total: r.total,
    errors: r.errors,
    success: r.total - r.errors,
    rate: r.total > 0 ? r.errors / r.total : 0,
  })).sort((a, b) => b.total - a.total)

  return { dailyRows, byModelOp, users, latencyByModel, errorRateByModel }
})
