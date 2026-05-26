/**
 * Account recovery via the one-time recovery key.
 *
 * Inputs: { email, recoveryKey (any case / hyphenation), newPassword }
 * Effect: unwraps the DEK with the recovery wrap key, re-wraps it under a
 *   fresh KDK derived from `newPassword`, replaces the password hash,
 *   re-issues a recovery key (so the old one can't be reused).
 *
 * Same rate limits as login. On success we log the user in directly —
 * they already authenticated themselves by knowing the recovery key.
 */
import type { H3Event } from 'h3'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody, setHeader } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { bcryptHashPassword, serializeUser } from '~/server/utils/auth'
import {
  ctEquals,
  deriveKdk,
  deriveRecoveryWrapKey,
  generateRecoveryKey,
  generateSalt,
  hashRecoveryKey,
  normaliseRecoveryKey,
  unwrap,
  wrap,
} from '~/server/utils/crypto'
import { dekToSessionValue } from '~/server/utils/dek'
import { getClientIp } from '~/server/utils/rate-limit'
import { consume } from '~/server/utils/rateLimit'

const Body = z.object({
  email: z.string().email().max(255),
  recoveryKey: z.string().min(8).max(120),
  newPassword: z.string().min(8).max(200),
})

const IP_LIMIT = 5
const IP_WINDOW_MS = 10 * 60_000
const EMAIL_LIMIT = 3
const EMAIL_WINDOW_MS = 30 * 60_000

function refuse(event: H3Event, retryAfterMs: number): never {
  setHeader(event, 'Retry-After', Math.max(1, Math.ceil(retryAfterMs / 1000)))
  throw createError({
    statusCode: 429,
    statusMessage: 'too_many_attempts',
    data: { retryAfterMs },
  })
}

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, Body.parse)
  const email = input.email.trim().toLowerCase()

  const ip = getClientIp(event)
  const ipKey = `auth:recover:ip:${ip}`
  const emailKey = `auth:recover:email:${email}`

  const ipCheck = consume(ipKey, IP_LIMIT, IP_WINDOW_MS)
  if (!ipCheck.ok) refuse(event, ipCheck.retryAfterMs)
  const emailCheck = consume(emailKey, EMAIL_LIMIT, EMAIL_WINDOW_MS)
  if (!emailCheck.ok) refuse(event, emailCheck.retryAfterMs)

  const db = useDb()
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (!row) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid recovery details' })
  }

  if (!row.encryptionEnabled || !row.kdfSalt || !row.recoveryWrappedDek || !row.recoveryKeyHash) {
    throw createError({
      statusCode: 400,
      statusMessage: 'recovery_unavailable',
      data: { detail: 'No recovery key on file — log in with your password and re-enable account recovery.' },
    })
  }

  const normalised = normaliseRecoveryKey(input.recoveryKey)
  const incomingHash = hashRecoveryKey(normalised)
  const ok = ctEquals(Buffer.from(incomingHash, 'hex'), Buffer.from(row.recoveryKeyHash, 'hex'))
  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid recovery details' })
  }

  let dek: Buffer
  try {
    const recoveryWrapKey = deriveRecoveryWrapKey(normalised, row.kdfSalt)
    dek = unwrap(row.recoveryWrappedDek, recoveryWrapKey)
  }
  catch (err) {
    console.error('[auth/recover] failed to unwrap DEK', row.id, err)
    throw createError({ statusCode: 401, statusMessage: 'Invalid recovery details' })
  }

  // Re-wrap under a brand-new password (so the previous password is dead),
  // and rotate the recovery key (the old one is now also dead).
  const newSalt = generateSalt()
  const newKdk = deriveKdk(input.newPassword, newSalt)
  const newWrappedDek = wrap(dek, newKdk)

  const newRecovery = generateRecoveryKey()
  const newRecoveryWrapKey = deriveRecoveryWrapKey(newRecovery.normalised, newSalt)
  const newRecoveryWrappedDek = wrap(dek, newRecoveryWrapKey)
  const newRecoveryKeyHash = hashRecoveryKey(newRecovery.normalised)

  const newPasswordHash = await bcryptHashPassword(input.newPassword)

  await db
    .update(users)
    .set({
      passwordHash: newPasswordHash,
      kdfSalt: newSalt,
      wrappedDek: newWrappedDek,
      recoveryWrappedDek: newRecoveryWrappedDek,
      recoveryKeyHash: newRecoveryKeyHash,
      encryptionEnabled: true,
    })
    .where(eq(users.id, row.id))

  const user = serializeUser(row)
  await setUserSession(event, {
    user,
    loggedInAt: Date.now(),
    dek: dekToSessionValue(dek),
  })

  return { user, recoveryKey: newRecovery.display }
})
