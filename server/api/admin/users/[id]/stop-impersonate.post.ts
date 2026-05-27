import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { serializeUser } from '~/server/utils/auth'
import { logAdminAction } from '~/server/utils/audit'

/**
 * Exit impersonation: restore the original admin's session.
 *
 * Reads `originalAdminId` from the current (impersonated) session, reloads
 * the admin user from the DB, and re-issues a session for them. The admin's
 * DEK is unrecoverable here (we'd need their password), so the restored
 * session has no DEK and the admin will need to re-login fully if they want
 * to access their own encrypted content.
 *
 * `:id` in the URL is the user currently being impersonated — used for
 * audit purposes; the actual switch is driven entirely by session state.
 */
export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const originalAdminId = session?.originalAdminId
  if (!originalAdminId) {
    throw createError({ statusCode: 400, statusMessage: 'Not currently impersonating' })
  }

  const db = useDb()
  const [admin] = await db.select().from(users).where(eq(users.id, originalAdminId)).limit(1)
  if (!admin || !admin.isAdmin) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Original admin account is unavailable' })
  }

  const impersonatedId = session?.user?.id ?? null

  await setUserSession(event, {
    user: serializeUser(admin),
    loggedInAt: Date.now(),
  })

  logAdminAction({
    adminId: admin.id,
    action: 'user.stop_impersonate',
    targetType: 'user',
    targetId: impersonatedId ?? undefined,
    payload: {},
  })

  return { ok: true }
})
