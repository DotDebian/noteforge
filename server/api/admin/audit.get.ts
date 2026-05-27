import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const Query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actionPrefix: z.string().optional(),
  adminId: z.coerce.number().int().positive().optional(),
})

interface RawRow {
  id: number
  createdAt: number
  adminId: number
  adminEmail: string | null
  action: string
  targetType: string | null
  targetId: number | null
  payload: string | null
}

interface AdminPick {
  id: number
  email: string
  count: number
}

interface ActionPick {
  action: string
  count: number
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { page, limit, actionPrefix, adminId } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()
  const offset = (page - 1) * limit

  const filters: string[] = []
  const params: Array<string | number> = []
  if (actionPrefix) {
    filters.push('a.action LIKE ?')
    params.push(`${actionPrefix}%`)
  }
  if (adminId) {
    filters.push('a.admin_id = ?')
    params.push(adminId)
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

  const totalRow = db.prepare(
    `SELECT count(*) AS cnt FROM admin_audit_log a ${where}`,
  ).get(...params) as { cnt: number }
  const total = totalRow.cnt

  const rows = db.prepare(
    `SELECT a.id, a.created_at AS createdAt,
            a.admin_id AS adminId, u.email AS adminEmail,
            a.action, a.target_type AS targetType,
            a.target_id AS targetId, a.payload
     FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.admin_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as RawRow[]

  /* ---- Filter option lists (top admins + top action prefixes) ---- */
  const admins = db.prepare(
    `SELECT u.id, u.email, count(*) AS count
     FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.admin_id
     GROUP BY a.admin_id
     ORDER BY count DESC
     LIMIT 50`,
  ).all() as AdminPick[]

  const actions = db.prepare(
    `SELECT action, count(*) AS count
     FROM admin_audit_log
     GROUP BY action
     ORDER BY count DESC
     LIMIT 50`,
  ).all() as ActionPick[]

  return {
    total,
    page,
    limit,
    rows: rows.map(r => ({
      id: r.id,
      createdAt: new Date(r.createdAt * 1000).toISOString(),
      adminId: r.adminId,
      adminEmail: r.adminEmail,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      payload: r.payload,
    })),
    filters: { admins, actions },
  }
})
