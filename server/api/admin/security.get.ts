import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

interface DayLoginRow {
  day: string
  success: number
  failed: number
}
interface SuspiciousAttempt {
  email: string
  createdAt: number
  ipAddress: string | null
}
interface RecentFailureRow {
  id: number
  createdAt: number
  email: string
  errorCode: string | null
  ipAddress: string | null
}
interface AuditResetRow {
  id: number
  createdAt: number
  action: string
  adminId: number
  adminEmail: string | null
  targetType: string | null
  targetId: number | null
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = getRawDb()

  /* ---- Today: success / failure ---- */
  const today = db.prepare(
    `SELECT
       sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
       sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
     FROM login_attempts
     WHERE created_at >= unixepoch('now', 'start of day')`,
  ).get() as { success: number | null, failed: number | null }

  /* ---- 7-day chart ---- */
  const weekRows = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day,
            sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
            sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
     FROM login_attempts
     WHERE created_at >= unixepoch('now', '-7 days')
     GROUP BY day
     ORDER BY day`,
  ).all() as DayLoginRow[]

  /* ---- Suspicious: emails with >=5 failed attempts in any 60-min window
         over the last 24 hours.
         Strategy: fetch all failed attempts in last 24h, group by email,
         then for each email sort by createdAt and slide a 60-min window. ---- */
  const failed24h = db.prepare(
    `SELECT email, created_at AS createdAt, ip_address AS ipAddress
     FROM login_attempts
     WHERE success = 0
       AND created_at >= unixepoch('now', '-24 hours')
     ORDER BY email, created_at`,
  ).all() as SuspiciousAttempt[]

  const byEmail = new Map<string, SuspiciousAttempt[]>()
  for (const a of failed24h) {
    const arr = byEmail.get(a.email) ?? []
    arr.push(a)
    byEmail.set(a.email, arr)
  }
  interface SuspiciousRow {
    email: string
    failCount: number
    lastAttempt: string
    lastIp: string | null
  }
  const suspicious: SuspiciousRow[] = []
  for (const [email, attempts] of byEmail.entries()) {
    let maxWindow = 0
    let left = 0
    for (let right = 0; right < attempts.length; right++) {
      while (left < right && (attempts[right]!.createdAt - attempts[left]!.createdAt) > 3600) {
        left++
      }
      const size = right - left + 1
      if (size > maxWindow) maxWindow = size
    }
    if (maxWindow >= 5) {
      const last = attempts[attempts.length - 1]!
      suspicious.push({
        email,
        failCount: maxWindow,
        lastAttempt: new Date(last.createdAt * 1000).toISOString(),
        lastIp: last.ipAddress,
      })
    }
  }
  suspicious.sort((a, b) => b.failCount - a.failCount)

  /* ---- Recent failures (last 100) ---- */
  const recentFailures = db.prepare(
    `SELECT id, created_at AS createdAt, email, error_code AS errorCode, ip_address AS ipAddress
     FROM login_attempts
     WHERE success = 0
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all() as RecentFailureRow[]

  /* ---- Recent admin-side password resets from audit log ---- */
  const adminResets = db.prepare(
    `SELECT a.id, a.created_at AS createdAt, a.action, a.admin_id AS adminId,
            u.email AS adminEmail, a.target_type AS targetType, a.target_id AS targetId
     FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.admin_id
     WHERE a.action LIKE 'user.reset_password%'
     ORDER BY a.created_at DESC
     LIMIT 50`,
  ).all() as AuditResetRow[]

  return {
    today: {
      success: today?.success ?? 0,
      failed: today?.failed ?? 0,
    },
    week: weekRows,
    suspicious,
    recentFailures: recentFailures.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt * 1000).toISOString(),
    })),
    adminResets: adminResets.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt * 1000).toISOString(),
    })),
  }
})
