import { and, eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { favorites } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

/**
 * Unstar a document for the current user. No-op if the favorite did not
 * exist.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  await assertDocumentAccess(event, id)

  const db = useDb()
  await db
    .delete(favorites)
    .where(and(eq(favorites.userId, user.id), eq(favorites.docId, id)))

  return { favorited: false }
})
