import { and, eq } from 'drizzle-orm'
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { useDb } from '~/server/database/client'
import { shareTokens } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'

/**
 * Revoke a share token. Stamps `revoked_at`; the public route filters those
 * out so revoking is effective immediately.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  await assertDocumentAccess(event, id)

  const token = getRouterParam(event, 'token')
  if (!token) {
    throw createError({ statusCode: 400, statusMessage: 'Missing token' })
  }

  const db = useDb()
  await db
    .update(shareTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareTokens.token, token), eq(shareTokens.docId, id)))

  return { ok: true }
})
