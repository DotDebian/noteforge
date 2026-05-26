import { and, desc, eq, isNull } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { mcpTokens } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'

/**
 * List the current user's active MCP tokens. The hash is never returned —
 * only id / name / prefix / dates so the UI can render the table + revoke
 * buttons.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const rows = await db
    .select({
      id: mcpTokens.id,
      name: mcpTokens.name,
      prefix: mcpTokens.prefix,
      lastUsedAt: mcpTokens.lastUsedAt,
      createdAt: mcpTokens.createdAt,
    })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.userId, user.id), isNull(mcpTokens.revokedAt)))
    .orderBy(desc(mcpTokens.createdAt))

  return { tokens: rows }
})
