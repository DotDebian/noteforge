/**
 * POST /api/auth/2fa/disable — turn off 2FA after re-verifying the password.
 *
 * We require the current password (not a TOTP code) because a lost
 * authenticator is the most common reason a user wants to disable 2FA.
 * The row is hard-deleted so a future re-enrollment starts from a clean
 * state (`/setup` will INSERT instead of UPDATE).
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { userTotp } from '~/server/database/schema'
import { bcryptVerifyPassword } from '~/server/utils/auth'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  password: z.string().min(1).max(200),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const input = await readValidatedBody(event, Body.parse)

  const ok = await bcryptVerifyPassword(input.password, user.passwordHash)
  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: 'invalid_password' })
  }

  const db = useDb()
  await db.delete(userTotp).where(eq(userTotp.userId, user.id))

  return { ok: true }
})
