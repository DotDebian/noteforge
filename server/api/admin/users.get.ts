import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const Query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().optional(),
  status: z.enum(['all', 'active', 'disabled', 'admin']).default('all'),
  sort: z.enum(['recent', 'last_login', 'docs', 'tokens']).default('recent'),
})

function statusClause(status: 'all' | 'active' | 'disabled' | 'admin'): string {
  switch (status) {
    case 'active': return 'u.disabled_at IS NULL AND u.is_admin = 0'
    case 'disabled': return 'u.disabled_at IS NOT NULL'
    case 'admin': return 'u.is_admin = 1'
    case 'all':
    default: return '1=1'
  }
}

function orderClause(sort: 'recent' | 'last_login' | 'docs' | 'tokens'): string {
  switch (sort) {
    case 'last_login': return 'u.last_login_at DESC NULLS LAST, u.created_at DESC'
    case 'docs': return 'docCount DESC, u.created_at DESC'
    case 'tokens': return 'totalTokens DESC, u.created_at DESC'
    case 'recent':
    default: return 'u.created_at DESC'
  }
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { page, limit, q, status, sort } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()
  const offset = (page - 1) * limit
  const search = q ? `%${q.trim()}%` : null

  const where = [statusClause(status)]
  const args: unknown[] = []
  if (search) {
    where.push('(u.email LIKE ? OR u.display_name LIKE ?)')
    args.push(search, search)
  }
  const whereSql = `WHERE ${where.join(' AND ')}`

  const totalCount = (db.prepare(
    `SELECT count(*) AS cnt FROM users u ${whereSql}`,
  ).get(...args) as { cnt: number }).cnt

  const rows = db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName,
            u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
            u.is_admin AS isAdmin, u.disabled_at AS disabledAt,
            (SELECT count(*) FROM workspaces WHERE owner_id = u.id) AS workspaceCount,
            (SELECT count(*) FROM documents d
               JOIN workspaces w ON w.id = d.workspace_id
               WHERE w.owner_id = u.id AND d.deleted_at IS NULL) AS docCount,
            (SELECT coalesce(sum(total_tokens), 0) FROM ai_usage_logs WHERE user_id = u.id) AS totalTokens
     FROM users u
     ${whereSql}
     ORDER BY ${orderClause(sort)} LIMIT ? OFFSET ?`,
  ).all(...args, limit, offset) as Array<{
    id: number
    email: string
    displayName: string | null
    createdAt: number
    lastLoginAt: number | null
    isAdmin: number
    disabledAt: number | null
    workspaceCount: number
    docCount: number
    totalTokens: number
  }>

  return {
    users: rows.map(r => ({
      ...r,
      isAdmin: r.isAdmin === 1,
      createdAt: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null,
      lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt * 1000).toISOString() : null,
      disabledAt: r.disabledAt ? new Date(r.disabledAt * 1000).toISOString() : null,
    })),
    total: totalCount,
    page,
    limit,
  }
})
