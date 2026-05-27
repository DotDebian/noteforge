import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const Query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { page, limit, q } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()
  const offset = (page - 1) * limit
  const search = q ? `%${q.trim()}%` : null

  let totalCount: number
  let rows: Array<{
    id: number
    email: string
    displayName: string | null
    createdAt: number
    lastLoginAt: number | null
    isAdmin: number
    disabledAt: number | null
    workspaceCount: number
    docCount: number
  }>

  if (search) {
    totalCount = (db.prepare(
      'SELECT count(*) AS cnt FROM users u WHERE u.email LIKE ? OR u.display_name LIKE ?',
    ).get(search, search) as { cnt: number }).cnt

    rows = db.prepare(
      `SELECT u.id, u.email, u.display_name AS displayName,
              u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
              u.is_admin AS isAdmin, u.disabled_at AS disabledAt,
              (SELECT count(*) FROM workspaces WHERE owner_id = u.id) AS workspaceCount,
              (SELECT count(*) FROM documents d
                 JOIN workspaces w ON w.id = d.workspace_id
                 WHERE w.owner_id = u.id AND d.deleted_at IS NULL) AS docCount
       FROM users u
       WHERE u.email LIKE ? OR u.display_name LIKE ?
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    ).all(search, search, limit, offset) as typeof rows
  }
  else {
    totalCount = (db.prepare(
      'SELECT count(*) AS cnt FROM users',
    ).get() as { cnt: number }).cnt

    rows = db.prepare(
      `SELECT u.id, u.email, u.display_name AS displayName,
              u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
              u.is_admin AS isAdmin, u.disabled_at AS disabledAt,
              (SELECT count(*) FROM workspaces WHERE owner_id = u.id) AS workspaceCount,
              (SELECT count(*) FROM documents d
                 JOIN workspaces w ON w.id = d.workspace_id
                 WHERE w.owner_id = u.id AND d.deleted_at IS NULL) AS docCount
       FROM users u
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as typeof rows
  }

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
