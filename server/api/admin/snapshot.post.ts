/**
 * POST /api/admin/snapshot — capture a fresh row in `health_snapshots`.
 *
 * Gathers the live values for db size, users, non-deleted docs, chunks and
 * chat sessions, inserts one row via Drizzle, and returns it. Audited via
 * `logAdminAction`.
 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineEventHandler } from 'h3'
import { getRawDb, useDb } from '~/server/database/client'
import { healthSnapshots } from '~/server/database/schema'
import { requireAdmin } from '~/server/utils/require-admin'
import { logAdminAction } from '~/server/utils/audit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const db = getRawDb()

  let dbSizeBytes = 0
  try {
    const dbPath = resolve(process.cwd(), process.env.DATABASE_URL ?? 'data/noteforge.db')
    dbSizeBytes = statSync(dbPath).size
  }
  catch { /* path may differ in some envs */ }

  const usersCount = (db.prepare('SELECT count(*) AS cnt FROM users').get() as { cnt: number }).cnt
  const docsCount = (db.prepare('SELECT count(*) AS cnt FROM documents WHERE deleted_at IS NULL').get() as { cnt: number }).cnt
  const chunksCount = (db.prepare('SELECT count(*) AS cnt FROM doc_chunks').get() as { cnt: number }).cnt
  const sessionsCount = (db.prepare('SELECT count(*) AS cnt FROM chat_sessions').get() as { cnt: number }).cnt

  const [snapshot] = await useDb()
    .insert(healthSnapshots)
    .values({
      dbSizeBytes,
      usersCount,
      docsCount,
      chunksCount,
      sessionsCount,
    })
    .returning()

  logAdminAction({
    adminId: admin.id,
    action: 'health.snapshot',
    payload: { dbSizeBytes, usersCount, docsCount, chunksCount, sessionsCount },
  })

  return { snapshot }
})
