/**
 * Admin audit log helper.
 *
 * Fire-and-forget — never throws, never blocks the request. Mirrors the
 * pattern from `logMistralUsage` in `mistral.ts`.
 */
import { useDb } from '~/server/database/client'
import { adminAuditLog } from '~/server/database/schema'

export function logAdminAction(opts: {
  adminId: number
  action: string
  targetType?: string
  targetId?: number
  payload?: Record<string, unknown>
}): void {
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(adminAuditLog).values({
        adminId: opts.adminId,
        action: opts.action,
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        payload: opts.payload ?? null,
      })
    }
    catch { /* never surface audit-log errors */ }
  })
}
