import { and, eq, isNull } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { oauthClients } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'
import { revokeGrantsForClient } from '~/server/utils/oauth'

/**
 * Revoke an OAuth connector. Soft delete (stamp `revoked_at`) like MCP tokens,
 * but it must ALSO burn the grants it issued: revoking only the client would
 * leave already-issued access tokens working until they expire.
 *
 * Idempotent — re-revoking returns `ok: true`.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = parseIdParam(event)
  const db = useDb()

  const [existing] = await db
    .select({ id: oauthClients.id, userId: oauthClients.userId, revokedAt: oauthClients.revokedAt })
    .from(oauthClients)
    .where(eq(oauthClients.id, id))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Connector not found' })
  }
  if (existing.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  if (existing.revokedAt != null) {
    return { ok: true, revokedAt: existing.revokedAt }
  }

  const now = new Date()
  await db
    .update(oauthClients)
    .set({ revokedAt: now })
    .where(and(eq(oauthClients.id, id), isNull(oauthClients.revokedAt)))
  await revokeGrantsForClient(id)

  return { ok: true, revokedAt: now }
})
