/**
 * Application event log — structured replacement for ad-hoc `console.error`
 * calls that admins need to see. Levels mirror the standard ladder
 * (debug/info/warn/error). Fire-and-forget.
 */
import { useDb } from '~/server/database/client'
import { appLogs } from '~/server/database/schema'

export function logAppEvent(opts: {
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  context?: Record<string, unknown>
  userId?: number
}): void {
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(appLogs).values({
        level: opts.level,
        source: opts.source,
        message: opts.message,
        context: opts.context ?? null,
        userId: opts.userId ?? null,
      })
    }
    catch { /* swallow */ }
  })
}
