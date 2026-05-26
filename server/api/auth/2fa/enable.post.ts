/**
 * POST /api/auth/2fa/enable — finish TOTP enrollment.
 *
 * Verifies the 6-digit code the user typed into the authenticator app
 * against their stored (encrypted) secret. On success:
 *   - flips `enabled = true` + stamps `enabledAt`
 *   - generates 8 single-use backup codes, stores them hashed (SHA-256)
 *   - returns the plaintext backup codes ONCE so the UI can show + copy them
 *
 * Throws:
 *   - 404 if there's no pending enrollment row (caller must POST /setup first)
 *   - 409 if 2FA is already enabled (no-op — disable then re-enroll)
 *   - 401 if the code is wrong
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { userTotp } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'
import {
  decryptSecret,
  generateBackupCodes,
  hashBackupCode,
  verifyToken,
} from '~/server/utils/totp'

const Body = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'code_must_be_6_digits'),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const input = await readValidatedBody(event, Body.parse)
  const db = useDb()

  const [row] = await db
    .select()
    .from(userTotp)
    .where(eq(userTotp.userId, user.id))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: '2fa_not_initialized' })
  }

  if (row.enabled === true) {
    throw createError({ statusCode: 409, statusMessage: '2fa_already_enabled' })
  }

  const secret = decryptSecret(row.secretEncrypted)
  if (!verifyToken(input.code, secret)) {
    throw createError({ statusCode: 401, statusMessage: 'invalid_totp_code' })
  }

  // Generate + persist backup codes hashed; return plaintext for one-shot
  // display.
  const codes = generateBackupCodes(8)
  const hashed = codes.map(hashBackupCode)

  await db
    .update(userTotp)
    .set({ enabled: true, enabledAt: new Date(), backupCodes: hashed })
    .where(eq(userTotp.userId, user.id))

  return { backupCodes: codes }
})
