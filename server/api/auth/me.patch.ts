/**
 * PATCH /api/auth/me — partial profile update.
 *
 * Currently exposes only `displayName`. Email and password live behind
 * dedicated endpoints (email change isn't implemented; password lives at
 * `/api/auth/password`). Returning the updated `User` matches the shape
 * the rest of `/api/auth/*` uses.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'
import { serializeUser } from '~/server/utils/auth'

const Body = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readValidatedBody(event, (v) => Body.parse(v))

  if (body.displayName === undefined) {
    // No-op: caller passed an empty body. Mirror the current row.
    return { user: serializeUser(user) }
  }

  const db = useDb()
  const [updated] = await db
    .update(users)
    .set({ displayName: body.displayName })
    .where(eq(users.id, user.id))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 500, statusMessage: 'update_failed' })
  }

  // Update the live session payload too so the sidebar shows the new name
  // without a refresh. We re-emit the full user shape (id + email + name)
  // rather than spreading, because the User interface is augmented in
  // `types/auth.d.ts` and TS requires both id/email to be present.
  const sess = await getUserSession(event)
  await setUserSession(event, {
    ...sess,
    user: {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName ?? null,
    },
  })

  return { user: serializeUser(updated) }
})
