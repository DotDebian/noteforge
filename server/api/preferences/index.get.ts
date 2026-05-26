/**
 * GET /api/preferences — fetch (or lazily create) the current user's
 * per-user preference row. The schema defaults the three JSON blobs to `{}`,
 * so a missing row is functionally equivalent — we still upsert one on first
 * read so subsequent PATCHes have something to merge into.
 */
import { eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { userPreferences, type UserPreferences } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, user.id))
    .limit(1)

  if (existing) {
    return { preferences: existing satisfies UserPreferences }
  }

  // Insert a default row so future PATCHes have a target.
  const [created] = await db
    .insert(userPreferences)
    .values({ userId: user.id, editor: {}, ai: {}, notifications: {} })
    .returning()

  if (!created) {
    return {
      preferences: {
        userId: user.id,
        editor: {},
        ai: {},
        notifications: {},
        updatedAt: new Date(),
      } satisfies UserPreferences,
    }
  }

  return { preferences: created satisfies UserPreferences }
})
