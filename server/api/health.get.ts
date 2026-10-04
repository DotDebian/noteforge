/**
 * GET /api/health — unauthenticated liveness probe.
 *
 * Reports:
 *  - db: "ok" if a trivial `SELECT 1` works against SQLite, else "down".
 *  - claude / voyage / mistral: "ok" if a call to that provider succeeded
 *    within the last 5 minutes (see `server/utils/provider-health.ts`); never
 *    makes a real API call.
 *  - uptimeMs: process uptime in milliseconds.
 *  - status: "ok" iff db === "ok", else "degraded".
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { getProviderStatus } from '~/server/utils/provider-health'

interface HealthResponse {
  status: 'ok' | 'degraded'
  db: 'ok' | 'down'
  claude: 'ok' | 'unknown'
  voyage: 'ok' | 'unknown'
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

  const claude = getProviderStatus('claude')
  const voyage = getProviderStatus('voyage')
  const mistral = getProviderStatus('mistral')
  const uptimeMs = Math.round(process.uptime() * 1000)
  const status: 'ok' | 'degraded' = db === 'ok' ? 'ok' : 'degraded'

  return { status, db, claude, voyage, mistral, uptimeMs }
})
