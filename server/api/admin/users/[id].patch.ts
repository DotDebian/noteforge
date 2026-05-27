import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { defineEventHandler, createError, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { requireAdmin } from '~/server/utils/require-admin'
import { parseIdParam } from '~/server/utils/access'
import { logAdminAction } from '~/server/utils/audit'

const Body = z.object({
  action: z.enum(['disable', 'enable', 'promote', 'demote']),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const targetId = parseIdParam(event)
  const { action } = await readValidatedBody(event, Body.parse)

  if (targetId === admin.id && (action === 'demote' || action === 'disable')) {
    throw createError({ statusCode: 400, statusMessage: 'Cannot modify your own admin status or disable yourself' })
  }

  const db = useDb()
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const update =
    action === 'disable' ? { disabledAt: new Date() }
    : action === 'enable' ? { disabledAt: null }
    : action === 'promote' ? { isAdmin: true }
    : { isAdmin: false }

  const [updated] = await db
    .update(users)
    .set(update)
    .where(eq(users.id, targetId))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 500, statusMessage: 'Update failed' })
  }

  logAdminAction({
    adminId: admin.id,
    action: `user.${action}`,
    targetType: 'user',
    targetId,
    payload: {},
  })

  return {
    user: {
      id: updated.id,
      email: updated.email,
      isAdmin: updated.isAdmin,
      disabledAt: updated.disabledAt ? updated.disabledAt.toISOString() : null,
    },
  }
})
