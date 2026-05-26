import type { H3Event } from 'h3'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody, setHeader } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { bcryptHashPassword, serializeUser } from '~/server/utils/auth'
import {
  deriveKdk,
  deriveRecoveryWrapKey,
  generateDek,
  generateRecoveryKey,
  generateSalt,
  hashRecoveryKey,
  wrap,
} from '~/server/utils/crypto'
import { dekToSessionValue } from '~/server/utils/dek'
import { getClientIp } from '~/server/utils/rate-limit'
import { consume } from '~/server/utils/rateLimit'

const Body = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120).optional(),
  inviteCode: z.string().min(1).max(64),
})

const IP_LIMIT = 10
const IP_WINDOW_MS = 5 * 60_000
const EMAIL_LIMIT = 5
const EMAIL_WINDOW_MS = 10 * 60_000

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

  const expectedInvite = (useRuntimeConfig(event).inviteCode as string) || 'NLJELA'
  if (input.inviteCode.trim().toUpperCase() !== expectedInvite.trim().toUpperCase()) {
    throw createError({ statusCode: 403, statusMessage: 'invalid_invite_code' })
  }

  const ip = getClientIp(event)
  const ipKey = `auth:register:ip:${ip}`
  const emailKey = `auth:register:email:${email}`

  const ipCheck = consume(ipKey, IP_LIMIT, IP_WINDOW_MS)
  if (!ipCheck.ok) refuse(event, ipCheck.retryAfterMs)

  const emailCheck = consume(emailKey, EMAIL_LIMIT, EMAIL_WINDOW_MS)
  if (!emailCheck.ok) refuse(event, emailCheck.retryAfterMs)

  const db = useDb()

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: 'Email already registered' })
  }

  const passwordHash = await bcryptHashPassword(input.password)

  // ---- Encryption setup ----------------------------------------------------
  // Generate a fresh per-user DEK and wrap it twice: once with the password-
  // derived KDK (normal login path) and once with a recovery-key-derived
  // wrap key (forgot-password path). The clear DEK and clear recovery key
  // are shown to the user this turn only — neither is persisted.
  const kdfSalt = generateSalt()
  const kdk = deriveKdk(input.password, kdfSalt)
  const dek = generateDek()
  const wrappedDek = wrap(dek, kdk)

  const recovery = generateRecoveryKey()
  const recoveryWrapKey = deriveRecoveryWrapKey(recovery.normalised, kdfSalt)
  const recoveryWrappedDek = wrap(dek, recoveryWrapKey)
  const recoveryKeyHash = hashRecoveryKey(recovery.normalised)

  const [createdUser] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: input.displayName ?? null,
      kdfSalt,
      wrappedDek,
      recoveryWrappedDek,
      recoveryKeyHash,
      encryptionEnabled: true,
    })
    .returning()

  if (!createdUser) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create user' })
  }

  // No default workspace — the user picks their first workspace from the
  // wizard on `/` (pages/index.vue).
  const user = serializeUser(createdUser)
  await setUserSession(event, {
    user,
    loggedInAt: Date.now(),
    dek: dekToSessionValue(dek),
  })

  // The clear recovery key is returned exactly once — the UI must persuade
  // the user to save it. Past this response it is unrecoverable.
  return { user, recoveryKey: recovery.display }
})
