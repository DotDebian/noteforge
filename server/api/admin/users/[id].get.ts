import { defineEventHandler, createError } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'
import { parseIdParam } from '~/server/utils/access'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const userId = parseIdParam(event)
  const db = getRawDb()

  const user = db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName,
            u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
            u.is_admin AS isAdmin, u.disabled_at AS disabledAt,
            (SELECT count(*) FROM workspaces WHERE owner_id = u.id) AS workspaceCount,
            (SELECT count(*) FROM documents d
               JOIN workspaces w ON w.id = d.workspace_id
               WHERE w.owner_id = u.id AND d.deleted_at IS NULL) AS docCount,
            (SELECT count(*) FROM doc_chunks dc
               JOIN documents d ON d.id = dc.doc_id
               JOIN workspaces w ON w.id = d.workspace_id
               WHERE w.owner_id = u.id) AS chunkCount,
            (SELECT count(*) FROM chat_sessions WHERE user_id = u.id) AS chatSessionCount
     FROM users u WHERE u.id = ?`,
  ).get(userId) as {
    id: number
    email: string
    displayName: string | null
    createdAt: number
    lastLoginAt: number | null
    isAdmin: number
    disabledAt: number | null
    workspaceCount: number
    docCount: number
    chunkCount: number
    chatSessionCount: number
  } | undefined

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const workspaces = db.prepare(
    `SELECT id, name, emoji, created_at AS createdAt,
            (SELECT count(*) FROM documents WHERE workspace_id = w.id AND deleted_at IS NULL) AS docCount
     FROM workspaces w WHERE owner_id = ? ORDER BY created_at`,
  ).all(userId) as Array<{ id: number, name: string, emoji: string | null, createdAt: number, docCount: number }>

  const aiUsage = db.prepare(
    `SELECT model, operation,
            sum(prompt_tokens) AS promptTokens,
            sum(completion_tokens) AS completionTokens,
            sum(total_tokens) AS totalTokens
     FROM ai_usage_logs WHERE user_id = ?
     GROUP BY model, operation ORDER BY sum(total_tokens) DESC`,
  ).all(userId) as Array<{ model: string, operation: string, promptTokens: number, completionTokens: number, totalTokens: number }>

  // Quotas (nullable row — user may not have a custom quota set).
  const quotasRow = db.prepare(
    `SELECT max_docs AS maxDocs, max_tokens_month AS maxTokensMonth, max_workspaces AS maxWorkspaces
     FROM user_quotas WHERE user_id = ?`,
  ).get(userId) as { maxDocs: number | null, maxTokensMonth: number | null, maxWorkspaces: number | null } | undefined

  // MCP tokens — active / revoked split.
  const tokenStats = db.prepare(
    `SELECT
       count(*) AS total,
       sum(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
       sum(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
     FROM mcp_tokens WHERE user_id = ?`,
  ).get(userId) as { total: number, active: number | null, revoked: number | null }

  // Decryption failure count.
  const decryptionFailures = (db.prepare(
    'SELECT count(*) AS cnt FROM decryption_failures WHERE user_id = ?',
  ).get(userId) as { cnt: number }).cnt

  // Last activity = max of: lastLoginAt, latest ai_usage_logs.created_at,
  // latest chat_sessions.created_at. All in unix seconds; null-safe.
  const lastAiUsage = (db.prepare(
    'SELECT max(created_at) AS ts FROM ai_usage_logs WHERE user_id = ?',
  ).get(userId) as { ts: number | null }).ts
  const lastChat = (db.prepare(
    'SELECT max(created_at) AS ts FROM chat_sessions WHERE user_id = ?',
  ).get(userId) as { ts: number | null }).ts

  const candidates = [user.lastLoginAt, lastAiUsage, lastChat].filter((x): x is number => typeof x === 'number')
  const lastActivityTs = candidates.length > 0 ? Math.max(...candidates) : null

  return {
    user: {
      ...user,
      isAdmin: user.isAdmin === 1,
      createdAt: user.createdAt ? new Date(user.createdAt * 1000).toISOString() : null,
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt * 1000).toISOString() : null,
      disabledAt: user.disabledAt ? new Date(user.disabledAt * 1000).toISOString() : null,
    },
    workspaces: workspaces.map(w => ({
      ...w,
      createdAt: new Date(w.createdAt * 1000).toISOString(),
    })),
    aiUsage,
    quotas: quotasRow
      ? {
          maxDocs: quotasRow.maxDocs,
          maxTokensMonth: quotasRow.maxTokensMonth,
          maxWorkspaces: quotasRow.maxWorkspaces,
        }
      : null,
    mcpTokens: {
      active: Number(tokenStats?.active ?? 0),
      revoked: Number(tokenStats?.revoked ?? 0),
      total: Number(tokenStats?.total ?? 0),
    },
    decryptionFailures,
    lastActivityAt: lastActivityTs != null ? new Date(lastActivityTs * 1000).toISOString() : null,
  }
})
