import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { requireAdmin } from '~/server/utils/require-admin'
import { parseIdParam } from '~/server/utils/access'
import { logAdminAction } from '~/server/utils/audit'

/**
 * Hard-delete a user. Moderation / RGPD action. Cascades via FK to
 * workspaces / documents / chunks / chat / tokens / etc.
 *
 * Self-delete is refused — the admin must keep a working account on hand.
 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const targetId = parseIdParam(event)

  if (targetId === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'Cannot delete your own account' })
  }

  const db = useDb()
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  await db.delete(users).where(eq(users.id, targetId))

  logAdminAction({
    adminId: admin.id,
    action: 'user.delete',
    targetType: 'user',
    targetId,
    payload: { email: target.email },
  })

  return { ok: true }
})
