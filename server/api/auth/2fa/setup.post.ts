/**
 * POST /api/auth/2fa/setup — start TOTP enrollment.
 *
 * Generates a fresh base32 secret, encrypts it at rest, persists the row
 * with `enabled = false`, and returns the secret (clear) + an `otpauth://`
 * QR data URL the front-end shows during enrollment.
 *
 * If a row already exists and `enabled = true`, throws 409 — the caller has
 * to disable first (which deletes the row) before re-enrolling. If a row
 * exists but `enabled = false` (user closed the dialog mid-setup), we
 * overwrite with a fresh secret.
 *
 * Backup codes are NOT generated here — they're created in `enable.post.ts`
 * after the user proves possession of the authenticator, so we never have
 * to keep two copies in sync.
 */
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { userTotp } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'
import {
  encryptSecret,
  generateSecret,
  otpAuthUrl,
  qrDataUrl,
} from '~/server/utils/totp'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  // Reject if 2FA is already verified — the caller must disable first.
  const [existing] = await db
    .select()
    .from(userTotp)
    .where(eq(userTotp.userId, user.id))
    .limit(1)

  if (existing?.enabled === true) {
    throw createError({ statusCode: 409, statusMessage: '2fa_already_enabled' })
  }

  const secret = generateSecret()
  const encrypted = encryptSecret(secret)
  const otpauth = otpAuthUrl(user.email, secret)
  const qr = await qrDataUrl(otpauth)

  if (existing) {
    // Overwrite the in-progress enrollment with a fresh secret.
    await db
      .update(userTotp)
      .set({ secretEncrypted: encrypted, enabled: false, backupCodes: [] })
      .where(eq(userTotp.userId, user.id))
  }
  else {
    await db.insert(userTotp).values({
      userId: user.id,
      secretEncrypted: encrypted,
      enabled: false,
      backupCodes: [],
    })
  }

  return {
    secret,
    qrDataUrl: qr,
    otpauthUrl: otpauth,
  }
})
