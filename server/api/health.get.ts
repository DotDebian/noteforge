/**
 * GET /api/health — unauthenticated liveness probe.
 *
 * Reports:
 *  - db: "ok" if a trivial `SELECT 1` works against SQLite, else "down".
 *  - mistral: "ok" if a Mistral call succeeded within the last 5 minutes
 *    (see `server/utils/mistral-health.ts`); never makes a real API call.
 *  - uptimeMs: process uptime in milliseconds.
 *  - status: "ok" iff db === "ok", else "degraded".
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { getMistralStatus } from '~/server/utils/mistral-health'

interface HealthResponse {
  status: 'ok' | 'degraded'
  db: 'ok' | 'down'
  mistral: 'ok' | 'unknown'
  uptimeMs: number
}

export default defineEventHandler((): HealthResponse => {
  let db: 'ok' | 'down' = 'ok'
  try {
    useDb().run(sql`SELECT 1`)
  }
  catch {
    db = 'down'
  }

  const mistral = getMistralStatus()
  const uptimeMs = Math.round(process.uptime() * 1000)
  const status: 'ok' | 'degraded' = db === 'ok' ? 'ok' : 'degraded'

  return { status, db, mistral, uptimeMs }
})
