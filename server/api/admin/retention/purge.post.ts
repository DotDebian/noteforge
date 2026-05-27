/**
 * POST /api/admin/retention/purge — apply the retention policy for one key by
 * hard-deleting the rows older than the configured TTL. No-op (returns 0) if
 * the policy is null. Audited as `retention.run`.
 */
import { z } from 'zod'
import { defineEventHandler, readValidatedBody, createError } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'
import { logAdminAction } from '~/server/utils/audit'
import { RETENTION_KEYS, type RetentionKey } from '../retention.get'

const Body = z.object({
  key: z.enum(RETENTION_KEYS),
})

interface PolicyRow {
  value: string
}

function parseTtlDays(raw: string | undefined): number | null {
  if (!raw || raw === 'null' || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function runDelete(db: ReturnType<typeof getRawDb>, key: RetentionKey, ttlDays: number): number {
  const cutoff = `unixepoch('now', '-${ttlDays} days')`
  switch (key) {
    case 'trash_ttl_days': {
      const purge = db.transaction(() => {
        const docs = db.prepare(
          `DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
        ).run()
        const folders = db.prepare(
          `DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
        ).run()
        return docs.changes + folders.changes
      })
      return purge()
    }
    case 'ai_usage_logs_ttl_days':
      return db.prepare(
        `DELETE FROM ai_usage_logs WHERE created_at < ${cutoff}`,
      ).run().changes
    case 'login_attempts_ttl_days':
      return db.prepare(
        `DELETE FROM login_attempts WHERE created_at < ${cutoff}`,
      ).run().changes
    case 'mcp_call_logs_ttl_days':
      return db.prepare(
        `DELETE FROM mcp_call_logs WHERE created_at < ${cutoff}`,
      ).run().changes
    case 'app_logs_ttl_days':
      return db.prepare(
        `DELETE FROM app_logs WHERE created_at < ${cutoff}`,
      ).run().changes
    case 'rag_quality_logs_ttl_days':
      return db.prepare(
        `DELETE FROM rag_quality_logs WHERE created_at < ${cutoff}`,
      ).run().changes
  }
}

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const { key } = await readValidatedBody(event, Body.parse)
  const db = getRawDb()

  const row = db.prepare(
    `SELECT value FROM retention_policy WHERE key = ?`,
  ).get(key) as PolicyRow | undefined

  const ttlDays = parseTtlDays(row?.value)
  if (ttlDays == null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Aucune politique configurée pour cette clé (purge impossible).',
    })
  }

  const rowsDeleted = runDelete(db, key, ttlDays)

  logAdminAction({
    adminId: admin.id,
    action: 'retention.run',
    payload: { key, ttlDays, rowsDeleted },
  })

  return { rowsDeleted }
})
