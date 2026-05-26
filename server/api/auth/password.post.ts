import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { bcryptHashPassword, bcryptVerifyPassword } from '~/server/utils/auth'
import {
  deriveKdk,
  deriveRecoveryWrapKey,
  generateRecoveryKey,
  generateSalt,
  hashRecoveryKey,
  unwrap,
  wrap,
} from '~/server/utils/crypto'
import { dekToSessionValue, getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const input = await readValidatedBody(event, Body.parse)

  const ok = await bcryptVerifyPassword(input.currentPassword, user.passwordHash)
  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid current password' })
  }

  const db = useDb()

  // Re-wrap the DEK under the new password. Prefer the live session DEK
  // (avoids a second scrypt round-trip), but fall back to deriving from
  // the current password if the session doesn't have one for any reason.
  let dek = await getDek(event)
  if (!dek && user.kdfSalt && user.wrappedDek) {
    const oldKdk = deriveKdk(input.currentPassword, user.kdfSalt)
    try {
      dek = unwrap(user.wrappedDek, oldKdk)
    }
    catch {
      throw createError({ statusCode: 401, statusMessage: 'Invalid current password' })
    }
  }
  if (!dek) {
    throw createError({ statusCode: 500, statusMessage: 'Session is missing encryption key — please log out and back in.' })
  }

  const newSalt = generateSalt()
  const newKdk = deriveKdk(input.newPassword, newSalt)
  const newWrappedDek = wrap(dek, newKdk)

  // Rotate the recovery key too — best practice on password change.
  const newRecovery = generateRecoveryKey()
  const newRecoveryWrapKey = deriveRecoveryWrapKey(newRecovery.normalised, newSalt)
  const newRecoveryWrappedDek = wrap(dek, newRecoveryWrapKey)
  const newRecoveryKeyHash = hashRecoveryKey(newRecovery.normalised)

  const newHash = await bcryptHashPassword(input.newPassword)
  await db
    .update(users)
    .set({
      passwordHash: newHash,
      kdfSalt: newSalt,
      wrappedDek: newWrappedDek,
      recoveryWrappedDek: newRecoveryWrappedDek,
      recoveryKeyHash: newRecoveryKeyHash,
      encryptionEnabled: true,
    })
    .where(eq(users.id, user.id))

  await setUserSession(event, {
    user: { id: user.id, email: user.email, displayName: user.displayName ?? null },
    loggedInAt: Date.now(),
    dek: dekToSessionValue(dek),
  })

  return { ok: true, recoveryKey: newRecovery.display }
})
