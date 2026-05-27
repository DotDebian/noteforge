import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { serializeUser } from '~/server/utils/auth'
import { requireAdmin } from '~/server/utils/require-admin'
import { parseIdParam } from '~/server/utils/access'
import { logAdminAction } from '~/server/utils/audit'

/**
 * Impersonate another user — set the admin's session to point at the
 * target user, so the admin sees the app exactly as the target would.
 *
 * Critically, the target's DEK is NOT injected: we don't have the user's
 * password, so we can't unwrap their DEK. Encrypted content (notes, chunks,
 * chat messages...) will therefore render as ciphertext / be unreadable.
 * That's deliberate — impersonation lets the admin verify structure, layout
 * and feature reachability, not snoop on private content. A banner in
 * `layouts/default.vue` reminds them they're impersonating + provides an
 * exit.
 *
 * Self-impersonation and impersonating other admins are refused.
 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const targetId = parseIdParam(event)

  if (targetId === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'Cannot impersonate yourself' })
  }

  const db = useDb()
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }
  if (target.isAdmin) {
    throw createError({ statusCode: 400, statusMessage: 'Cannot impersonate another admin' })
  }

  const user = serializeUser(target)

  // Wipe DEK from the session (target's DEK is unrecoverable). The
  // `originalAdminId` + `impersonating` flags let the front draw the
  // banner and call `/stop-impersonate` to restore the admin's own session.
  await setUserSession(event, {
    user,
    loggedInAt: Date.now(),
    originalAdminId: admin.id,
    impersonating: true,
  })

  logAdminAction({
    adminId: admin.id,
    action: 'user.impersonate',
    targetType: 'user',
    targetId,
    payload: { email: target.email },
  })

  return {
    ok: true,
    user: {
      id: target.id,
      email: target.email,
      displayName: target.displayName ?? null,
    },
  }
})
