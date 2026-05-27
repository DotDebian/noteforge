/**
 * Login attempt log. Captures successes and failures (with error codes) for
 * abuse / lockout dashboards.
 *
 * Fire-and-forget — never throws, never blocks the response.
 */
import { useDb } from '~/server/database/client'
import { loginAttempts } from '~/server/database/schema'

export function logLoginAttempt(opts: {
  email: string
  userId?: number
  success: boolean
  errorCode?: string
  ipAddress?: string
  userAgent?: string
}): void {
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(loginAttempts).values({
        email: opts.email,
        userId: opts.userId ?? null,
        success: opts.success,
        errorCode: opts.errorCode ?? null,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      })
    }
    catch { /* swallow */ }
  })
}
