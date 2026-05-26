import { and, eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { savedSearches } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)

  const db = useDb()
  const [existing] = await db
    .select({ id: savedSearches.id, userId: savedSearches.userId })
    .from(savedSearches)
    .where(eq(savedSearches.id, id))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Saved search not found' })
  }
  if (existing.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  await db.delete(savedSearches).where(and(
    eq(savedSearches.id, id),
    eq(savedSearches.userId, user.id),
  ))

  return { ok: true }
})
