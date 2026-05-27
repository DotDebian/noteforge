import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

const Query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

interface UserStatusRow {
  id: number
  email: string
  encryptionEnabled: number
  hasWrappedDek: number
  hasRecovery: number
  hasKdfSalt: number
}
interface PerEntityRow {
  entityType: string
  count: number
}
interface RecentFailureRow {
  id: number
  createdAt: number
  userId: number | null
  email: string | null
  entityType: string
  entityId: number | null
  field: string
  errorMessage: string | null
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { page, limit } = await getValidatedQuery(event, Query.parse)
  const db = getRawDb()
  const offset = (page - 1) * limit

  /* ---- Aggregate user encryption state ---- */
  const userAgg = db.prepare(
    `SELECT
       sum(CASE WHEN encryption_enabled = 1 THEN 1 ELSE 0 END) AS migrated,
       sum(CASE WHEN encryption_enabled = 0 THEN 1 ELSE 0 END) AS legacy,
       sum(CASE WHEN encryption_enabled = 1 AND wrapped_dek IS NULL THEN 1 ELSE 0 END) AS broken,
       count(*) AS total
     FROM users`,
  ).get() as { migrated: number, legacy: number, broken: number, total: number }

  /* ---- Decryption failure stats (7 days) ---- */
  const failuresTotal = (db.prepare(
    `SELECT count(*) AS cnt
     FROM decryption_failures
     WHERE created_at >= unixepoch('now', '-7 days')`,
  ).get() as { cnt: number }).cnt

  const failuresByType = db.prepare(
    `SELECT entity_type AS entityType, count(*) AS count
     FROM decryption_failures
     WHERE created_at >= unixepoch('now', '-7 days')
     GROUP BY entity_type
     ORDER BY count DESC`,
  ).all() as PerEntityRow[]

  const recentFailures = db.prepare(
    `SELECT f.id, f.created_at AS createdAt,
            f.user_id AS userId, u.email AS email,
            f.entity_type AS entityType, f.entity_id AS entityId,
            f.field, f.error_message AS errorMessage
     FROM decryption_failures f
     LEFT JOIN users u ON u.id = f.user_id
     ORDER BY f.created_at DESC
     LIMIT 100`,
  ).all() as RecentFailureRow[]

  /* ---- Per-user state (paginated) ---- */
  const usersTotal = (db.prepare(
    'SELECT count(*) AS cnt FROM users',
  ).get() as { cnt: number }).cnt

  const usersRows = db.prepare(
    `SELECT id, email,
            CASE WHEN encryption_enabled = 1 THEN 1 ELSE 0 END AS encryptionEnabled,
            CASE WHEN wrapped_dek IS NOT NULL THEN 1 ELSE 0 END AS hasWrappedDek,
            CASE WHEN recovery_wrapped_dek IS NOT NULL THEN 1 ELSE 0 END AS hasRecovery,
            CASE WHEN kdf_salt IS NOT NULL THEN 1 ELSE 0 END AS hasKdfSalt
     FROM users
     ORDER BY id ASC
     LIMIT ? OFFSET ?`,
  ).all(limit, offset) as UserStatusRow[]

  return {
    stats: {
      total: userAgg?.total ?? 0,
      migrated: userAgg?.migrated ?? 0,
      legacy: userAgg?.legacy ?? 0,
      broken: userAgg?.broken ?? 0,
    },
    failures: {
      total7d: failuresTotal,
      byType: failuresByType,
    },
    recentFailures: recentFailures.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt * 1000).toISOString(),
    })),
    users: {
      total: usersTotal,
      page,
      limit,
      rows: usersRows.map(r => ({
        id: r.id,
        email: r.email,
        encryptionEnabled: r.encryptionEnabled === 1,
        hasWrappedDek: r.hasWrappedDek === 1,
        hasRecovery: r.hasRecovery === 1,
        hasKdfSalt: r.hasKdfSalt === 1,
      })),
    },
  }
})
