import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { bcryptHashPassword } from '~/server/utils/auth'
import {
  deriveKdk,
  deriveRecoveryWrapKey,
  generateDek,
  generateRecoveryKey,
  generateSalt,
  hashRecoveryKey,
  wrap,
} from '~/server/utils/crypto'
import { requireAdmin } from '~/server/utils/require-admin'
import { parseIdParam } from '~/server/utils/access'
import { logAdminAction } from '~/server/utils/audit'

/**
 * Admin-side password reset.
 *
 * We don't have the user's current password and we don't have their old
 * recovery key, so the existing DEK is unrecoverable. This endpoint is
 * therefore an emergency / moderation tool: it WIPES the user's
 * cryptographic material and re-initialises it from scratch with a fresh
 * DEK + recovery key. Any encrypted content the user had (notes, chunks,
 * chat history, analyses, version snapshots) becomes unreadable.
 *
 * The caller MUST pass `confirmWipeDek: true` to acknowledge this. We also
 * require `newPassword` so the user can immediately log in with whatever
 * the admin set — the admin is expected to communicate the temporary
 * credentials out-of-band.
 *
 * Returns the new recovery key ONCE.
 */
const Body = z.object({
  newPassword: z.string().min(8).max(200),
  confirmWipeDek: z.literal(true),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const targetId = parseIdParam(event)

  if (targetId === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'Cannot reset your own password from the admin panel — use the account settings instead' })
  }

  const input = await readValidatedBody(event, Body.parse)

  const db = useDb()
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  // Fresh crypto material (mirrors register.post.ts).
  const kdfSalt = generateSalt()
  const kdk = deriveKdk(input.newPassword, kdfSalt)
  const dek = generateDek()
  const wrappedDek = wrap(dek, kdk)

  const recovery = generateRecoveryKey()
  const recoveryWrapKey = deriveRecoveryWrapKey(recovery.normalised, kdfSalt)
  const recoveryWrappedDek = wrap(dek, recoveryWrapKey)
  const recoveryKeyHash = hashRecoveryKey(recovery.normalised)

  const passwordHash = await bcryptHashPassword(input.newPassword)

  await db
    .update(users)
    .set({
      passwordHash,
      kdfSalt,
      wrappedDek,
      recoveryWrappedDek,
      recoveryKeyHash,
      encryptionEnabled: true,
    })
    .where(eq(users.id, targetId))

  logAdminAction({
    adminId: admin.id,
    action: 'user.reset_password',
    targetType: 'user',
    targetId,
    payload: { wipeDek: true },
  })

  return { ok: true, recoveryKey: recovery.display }
})
