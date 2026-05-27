/**
 * GET /api/admin/jobs — list rows from `jobs` with status / type filters,
 * pagination, stat cards (24h pipeline overview), and user-email lookup.
 */
import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const STATUS_VALUES = ['all', 'pending', 'running', 'completed', 'failed'] as const

const Query = z.object({
  status: z.enum(STATUS_VALUES).default('all'),
  type: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export interface JobsStats {
  pending: number
  running: number
  completed24h: number
  failed24h: number
  avgDurationMs24h: number
}

export interface JobRow {
  id: number
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  userId: number | null
  userEmail: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  errorMessage: string | null
  createdAt: string
}

export interface JobsResponse {
  stats: JobsStats
  types: string[]
  jobs: JobRow[]
  total: number
  page: number
  limit: number
}

interface JobRawRow {
  id: number
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  userId: number | null
  userEmail: string | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  errorMessage: string | null
  createdAt: number
}

function toIso(unix: number | null): string | null {
  return unix ? new Date(unix * 1000).toISOString() : null
}

export default defineEventHandler(async (event): Promise<JobsResponse> => {
  await requireAdmin(event)
  const { status, type, page, limit } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()
  const offset = (page - 1) * limit

  // Stat cards
  const pending = (db.prepare(
    `SELECT count(*) AS cnt FROM jobs WHERE status = 'pending'`,
  ).get() as { cnt: number }).cnt

  const running = (db.prepare(
    `SELECT count(*) AS cnt FROM jobs WHERE status = 'running'`,
  ).get() as { cnt: number }).cnt

  const completed24h = (db.prepare(
    `SELECT count(*) AS cnt FROM jobs
     WHERE status = 'completed' AND completed_at >= unixepoch('now', '-1 day')`,
  ).get() as { cnt: number }).cnt

  const failed24h = (db.prepare(
    `SELECT count(*) AS cnt FROM jobs
     WHERE status = 'failed' AND completed_at >= unixepoch('now', '-1 day')`,
  ).get() as { cnt: number }).cnt

  const avgDurRow = db.prepare(
    `SELECT avg(duration_ms) AS avgDur FROM jobs
     WHERE status = 'completed'
       AND duration_ms IS NOT NULL
       AND completed_at >= unixepoch('now', '-1 day')`,
  ).get() as { avgDur: number | null }

  // Types for filter dropdown
  const typesRows = db.prepare(
    `SELECT DISTINCT type FROM jobs ORDER BY type`,
  ).all() as Array<{ type: string }>

  // Build dynamic WHERE
  const conds: string[] = []
  const params: (string | number)[] = []
  if (status !== 'all') {
    conds.push('j.status = ?')
    params.push(status)
  }
  if (type) {
    conds.push('j.type = ?')
    params.push(type)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const total = (db.prepare(
    `SELECT count(*) AS cnt FROM jobs j ${where}`,
  ).get(...params) as { cnt: number }).cnt

  const rows = db.prepare(
    `SELECT j.id, j.type, j.status,
            j.user_id AS userId, u.email AS userEmail,
            j.started_at AS startedAt,
            j.completed_at AS completedAt,
            j.duration_ms AS durationMs,
            j.error_message AS errorMessage,
            j.created_at AS createdAt
     FROM jobs j
     LEFT JOIN users u ON u.id = j.user_id
     ${where}
     ORDER BY j.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as JobRawRow[]

  return {
    stats: {
      pending,
      running,
      completed24h,
      failed24h,
      avgDurationMs24h: Math.round(avgDurRow.avgDur ?? 0),
    },
    types: typesRows.map(t => t.type),
    jobs: rows.map(r => ({
      id: r.id,
      type: r.type,
      status: r.status,
      userId: r.userId,
      userEmail: r.userEmail,
      startedAt: toIso(r.startedAt),
      completedAt: toIso(r.completedAt),
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
      createdAt: new Date(r.createdAt * 1000).toISOString(),
    })),
    total,
    page,
    limit,
  }
})
