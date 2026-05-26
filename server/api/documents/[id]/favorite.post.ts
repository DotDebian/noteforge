import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { favorites } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

/**
 * Star / pin a document for the current user. Idempotent: re-favoriting an
 * already-favorited document is a no-op (INSERT OR IGNORE via Drizzle's
 * `onConflictDoNothing`).
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  await assertDocumentAccess(event, id)

  const db = useDb()
  await db
    .insert(favorites)
    .values({ userId: user.id, docId: id })
    .onConflictDoNothing()

  return { favorited: true }
})
