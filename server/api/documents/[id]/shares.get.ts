import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { shareTokens } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'

/**
 * List currently-active share tokens for a document. Filters out
 * revoked / expired rows so the client can show a clean list.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  await assertDocumentAccess(event, id)

  const db = useDb()
  const now = new Date()
  const rows = await db
    .select({
      token: shareTokens.token,
      createdAt: shareTokens.createdAt,
      expiresAt: shareTokens.expiresAt,
    })
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.docId, id),
        isNull(shareTokens.revokedAt),
        or(isNull(shareTokens.expiresAt), gt(shareTokens.expiresAt, now)),
      ),
    )
    .orderBy(desc(shareTokens.createdAt))

  return { shares: rows }
})
