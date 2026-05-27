/**
 * GET /api/admin/logs — list rows from `app_logs` with level / source / query
 * filters, pagination, plus 24h per-level counts for the stat cards.
 */
import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const LEVEL_VALUES = ['all', 'debug', 'info', 'warn', 'error'] as const
const STORED_LEVELS = ['debug', 'info', 'warn', 'error'] as const

const Query = z.object({
  level: z.enum(LEVEL_VALUES).default('all'),
  source: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AppLogRow {
  id: number
  level: AppLogLevel
  source: string
  message: string
  context: Record<string, unknown> | null
  userId: number | null
  userEmail: string | null
  createdAt: string
}

export interface AppLogsResponse {
  levelCounts24h: Record<AppLogLevel, number>
  sources: string[]
  logs: AppLogRow[]
  total: number
  page: number
  limit: number
}

interface LevelCountRow {
  level: AppLogLevel
  cnt: number
}

interface LogRawRow {
  id: number
  level: AppLogLevel
  source: string
  message: string
  context: string | null
  userId: number | null
  userEmail: string | null
  createdAt: number
}

export default defineEventHandler(async (event): Promise<AppLogsResponse> => {
  await requireAdmin(event)
  const { level, source, q, page, limit } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()
  const offset = (page - 1) * limit

  // 24h counts per level
  const lvlRows = db.prepare(
    `SELECT level, count(*) AS cnt
     FROM app_logs
     WHERE created_at >= unixepoch('now', '-1 day')
     GROUP BY level`,
  ).all() as LevelCountRow[]

  const levelCounts24h: Record<AppLogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const r of lvlRows) {
    if (STORED_LEVELS.includes(r.level)) {
      levelCounts24h[r.level] = r.cnt
    }
  }

  // Source dropdown values
  const sourceRows = db.prepare(
    `SELECT DISTINCT source FROM app_logs ORDER BY source`,
  ).all() as Array<{ source: string }>

  // Filter clause
  const conds: string[] = []
  const params: (string | number)[] = []
  if (level !== 'all') {
    conds.push('l.level = ?')
    params.push(level)
  }
  if (source) {
    conds.push('l.source = ?')
    params.push(source)
  }
  if (q) {
    conds.push('l.message LIKE ?')
    params.push(`%${q}%`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const total = (db.prepare(
    `SELECT count(*) AS cnt FROM app_logs l ${where}`,
  ).get(...params) as { cnt: number }).cnt

  const rows = db.prepare(
    `SELECT l.id, l.level, l.source, l.message, l.context,
            l.user_id AS userId, u.email AS userEmail,
            l.created_at AS createdAt
     FROM app_logs l
     LEFT JOIN users u ON u.id = l.user_id
     ${where}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as LogRawRow[]

  return {
    levelCounts24h,
    sources: sourceRows.map(s => s.source),
    logs: rows.map((r) => {
      let parsedContext: Record<string, unknown> | null = null
      if (r.context) {
        try {
          const parsed = JSON.parse(r.context) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedContext = parsed as Record<string, unknown>
          }
        }
        catch { /* leave null */ }
      }
      return {
        id: r.id,
        level: r.level,
        source: r.source,
        message: r.message,
        context: parsedContext,
        userId: r.userId,
        userEmail: r.userEmail,
        createdAt: new Date(r.createdAt * 1000).toISOString(),
      }
    }),
    total,
    page,
    limit,
  }
})
