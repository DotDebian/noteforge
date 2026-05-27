/**
 * GET /api/admin/retention — read the retention KV table and, for each known
 * key, compute how many rows would be deleted by `POST /api/admin/retention/purge`
 * if it ran right now. Lets the admin preview the blast radius before pulling
 * the trigger.
 */
import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

export const RETENTION_KEYS = [
  'trash_ttl_days',
  'ai_usage_logs_ttl_days',
  'login_attempts_ttl_days',
  'mcp_call_logs_ttl_days',
  'app_logs_ttl_days',
  'rag_quality_logs_ttl_days',
] as const
export type RetentionKey = typeof RETENTION_KEYS[number]

export interface RetentionPolicyRow {
  key: RetentionKey
  value: number | null
  previewRows: number
  updatedAt: string | null
}

export interface RetentionResponse {
  policies: RetentionPolicyRow[]
}

interface RawPolicyRow {
  key: string
  value: string
  updatedAt: number
}

function parseValue(raw: string | undefined): number | null {
  if (!raw) return null
  if (raw === 'null' || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function previewCount(db: ReturnType<typeof getRawDb>, key: RetentionKey, ttlDays: number | null): number {
  if (ttlDays == null) return 0
  const cutoff = `unixepoch('now', '-${ttlDays} days')`

  switch (key) {
    case 'trash_ttl_days': {
      const docs = (db.prepare(
        `SELECT count(*) AS cnt FROM documents
         WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
      const folders = (db.prepare(
        `SELECT count(*) AS cnt FROM folders
         WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
      return docs + folders
    }
    case 'ai_usage_logs_ttl_days':
      return (db.prepare(
        `SELECT count(*) AS cnt FROM ai_usage_logs WHERE created_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
    case 'login_attempts_ttl_days':
      return (db.prepare(
        `SELECT count(*) AS cnt FROM login_attempts WHERE created_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
    case 'mcp_call_logs_ttl_days':
      return (db.prepare(
        `SELECT count(*) AS cnt FROM mcp_call_logs WHERE created_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
    case 'app_logs_ttl_days':
      return (db.prepare(
        `SELECT count(*) AS cnt FROM app_logs WHERE created_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
    case 'rag_quality_logs_ttl_days':
      return (db.prepare(
        `SELECT count(*) AS cnt FROM rag_quality_logs WHERE created_at < ${cutoff}`,
      ).get() as { cnt: number }).cnt
  }
}

export default defineEventHandler(async (event): Promise<RetentionResponse> => {
  await requireAdmin(event)
  const db = getRawDb()

  const rows = db.prepare(
    `SELECT key, value, updated_at AS updatedAt FROM retention_policy`,
  ).all() as RawPolicyRow[]
  const byKey = new Map(rows.map(r => [r.key, r]))

  const policies: RetentionPolicyRow[] = RETENTION_KEYS.map((k) => {
    const row = byKey.get(k)
    const value = parseValue(row?.value)
    return {
      key: k,
      value,
      previewRows: previewCount(db, k, value),
      updatedAt: row?.updatedAt ? new Date(row.updatedAt * 1000).toISOString() : null,
    }
  })

  return { policies }
})
