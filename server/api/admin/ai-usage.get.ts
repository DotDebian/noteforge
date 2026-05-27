import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const Query = z.object({
  userId: z.coerce.number().int().positive().optional(),
  days: z.coerce.number().int().min(7).max(365).default(30),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { userId, days } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()

  type DailyRow = { day: string, model: string, promptTokens: number, completionTokens: number, totalTokens: number }
  type ModelOpRow = { model: string, operation: string, promptTokens: number, completionTokens: number, totalTokens: number }
  type UserRow = { id: number, email: string, displayName: string | null, totalTokens: number }

  let dailyRows: DailyRow[]
  let byModelOp: ModelOpRow[]

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
  }

  const users = db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName,
            sum(l.total_tokens) AS totalTokens
     FROM ai_usage_logs l
     JOIN users u ON u.id = l.user_id
     GROUP BY l.user_id ORDER BY sum(l.total_tokens) DESC LIMIT 50`,
  ).all() as UserRow[]

  return { dailyRows, byModelOp, users }
})
