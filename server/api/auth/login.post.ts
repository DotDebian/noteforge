import type { H3Event } from 'h3'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, getRequestHeader, readValidatedBody, setHeader } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { bcryptVerifyPassword, serializeUser } from '~/server/utils/auth'
import { deriveKdk, unwrap } from '~/server/utils/crypto'
import { dekToSessionValue } from '~/server/utils/dek'
import { migrateUserToEncrypted } from '~/server/utils/encryption-migration'
import { getClientIp } from '~/server/utils/rate-limit'
import { consume, release } from '~/server/utils/rateLimit'
import { logLoginAttempt } from '~/server/utils/loginAttempts'

const Body = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
})

// IP-based: 10 attempts / 5 min — slows credential-stuffing from one source.
const IP_LIMIT = 10
const IP_WINDOW_MS = 5 * 60_000

// Email-based: 5 failed attempts / 10 min — per-account lockout.
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

  const ip = getClientIp(event)
  const userAgent = getRequestHeader(event, 'user-agent') ?? undefined
  const ipKey = `auth:login:ip:${ip}`
  const emailKey = `auth:login:email:${email}`

  const ipCheck = consume(ipKey, IP_LIMIT, IP_WINDOW_MS)
  if (!ipCheck.ok) {
    logLoginAttempt({ email, success: false, errorCode: 'rate_limited', ipAddress: ip, userAgent })
    refuse(event, ipCheck.retryAfterMs)
  }

  // The email bucket is reserved BEFORE the credential check; on a successful
  // login we release it so legitimate users don't burn their own allowance.
  const emailCheck = consume(emailKey, EMAIL_LIMIT, EMAIL_WINDOW_MS)
  if (!emailCheck.ok) {
    logLoginAttempt({ email, success: false, errorCode: 'rate_limited', ipAddress: ip, userAgent })
    refuse(event, emailCheck.retryAfterMs)
  }

  const db = useDb()
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (!row) {
    logLoginAttempt({ email, success: false, errorCode: 'unknown_user', ipAddress: ip, userAgent })
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  const ok = await bcryptVerifyPassword(input.password, row.passwordHash)
  if (!ok) {
    logLoginAttempt({ email, userId: row.id, success: false, errorCode: 'bad_password', ipAddress: ip, userAgent })
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  if (row.disabledAt != null) {
    logLoginAttempt({ email, userId: row.id, success: false, errorCode: 'disabled', ipAddress: ip, userAgent })
    throw createError({ statusCode: 403, statusMessage: 'Account disabled' })
  }

  // Success — give the email bucket its token back. Failed attempts still
  // count, only the verified-good-password attempt is refunded.
  release(emailKey)

  // Record last login timestamp (fire-and-forget — never block the response).
  void db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id))

  /* ---- Encryption: unwrap the DEK (or migrate a legacy user) ----------- */
  let dek: Buffer
  let recoveryKey: string | undefined

  if (row.encryptionEnabled && row.kdfSalt && row.wrappedDek) {
    try {
      const kdk = deriveKdk(input.password, row.kdfSalt)
      dek = unwrap(row.wrappedDek, kdk)
    }
    catch (err) {
      // Either the password is good but the wrapped DEK is corrupt, or the
      // KDK is wrong for some other reason (re-derived against the wrong
      // salt). Surface as a 500 so the user sees a real error and not a
      // silent broken-session.
      console.error('[auth/login] failed to unwrap DEK for', row.id, err)
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not unlock account data',
      })
    }
  }
  else {
    // Legacy user — encrypt their data on the fly with the password they
    // just typed. Surface the recovery key in the response exactly once;
    // the UI shows it on the next screen with a copy / "I've saved it"
    // checkbox.
    try {
      const result = await migrateUserToEncrypted(row.id, input.password)
      dek = result.dek
      recoveryKey = result.recoveryKey
    }
    catch (err) {
      console.error('[auth/login] legacy-user encryption migration failed', row.id, err)
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not initialise account encryption',
      })
    }
  }

  const user = serializeUser(row)
  await setUserSession(event, {
    user,
    loggedInAt: Date.now(),
    dek: dekToSessionValue(dek),
  })

  logLoginAttempt({ email, userId: row.id, success: true, ipAddress: ip, userAgent })

  return recoveryKey ? { user, recoveryKey } : { user }
})
