import { and, eq, isNull } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { mcpTokens } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

/**
 * Revoke an MCP token. Soft delete: stamp `revoked_at = now()` so the
 * audit trail (creation, last use) survives. Idempotent — re-revoking
 * a token that's already revoked returns `ok: true`.
 *
 * Scoped to the authenticated user — you cannot revoke another user's
 * tokens.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = parseIdParam(event)
  const db = useDb()

  const [existing] = await db
    .select({ id: mcpTokens.id, userId: mcpTokens.userId, revokedAt: mcpTokens.revokedAt })
    .from(mcpTokens)
    .where(eq(mcpTokens.id, id))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Token not found' })
  }
  if (existing.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  if (existing.revokedAt != null) {
    return { ok: true, revokedAt: existing.revokedAt }
  }

  const now = new Date()
  const [updated] = await db
    .update(mcpTokens)
    .set({ revokedAt: now })
    .where(and(eq(mcpTokens.id, id), isNull(mcpTokens.revokedAt)))
    .returning({ revokedAt: mcpTokens.revokedAt })

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Token not found' })
  }

  return { ok: true, revokedAt: updated.revokedAt }
})
