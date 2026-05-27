/**
 * PATCH /api/admin/retention — upsert one KV row in `retention_policy`. Value
 * may be a positive integer (TTL in days) or `null` (= never purge). Validates
 * the key against the known whitelist before touching the DB. Audited as
 * `retention.update`.
 */
import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { sql } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { retentionPolicy } from '~/server/database/schema'
import { requireAdmin } from '~/server/utils/require-admin'
import { logAdminAction } from '~/server/utils/audit'
import { RETENTION_KEYS } from './retention.get'

const Body = z.object({
  key: z.enum(RETENTION_KEYS),
  value: z.number().int().min(1).nullable(),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const { key, value } = await readValidatedBody(event, Body.parse)
  const db = useDb()

  const storedValue = value == null ? 'null' : String(value)

  await db.insert(retentionPolicy)
    .values({ key, value: storedValue })
    .onConflictDoUpdate({
      target: retentionPolicy.key,
      set: {
        value: storedValue,
        updatedAt: sql`(unixepoch())`,
      },
    })

  logAdminAction({
    adminId: admin.id,
    action: 'retention.update',
    payload: { key, value },
  })

  return { ok: true, key, value }
})
