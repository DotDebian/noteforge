import type { H3Event } from 'h3'
import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { users, type User } from '~/server/database/schema'

/**
 * Resolve the currently authenticated user from the session and load
 * the full user record from the database. Throws 401 if not logged in
 * or if the session points at a user that no longer exists.
 */
export async function requireUser(event: H3Event): Promise<User> {
  const session = await getUserSession(event)
  const sessionUser = session?.user

  if (!sessionUser?.id) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }

  const db = useDb()
  const [row] = await db.select().from(users).where(eq(users.id, sessionUser.id)).limit(1)

  if (!row) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'User no longer exists' })
  }

  return row
}
