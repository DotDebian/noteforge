import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { documentVersions } from '~/server/database/schema'

/**
 * Sprint 5 / I9 — lazy version retention.
 *
 * Policy (only `autosave_snapshot` rows are eligible; `manual_snapshot` and
 * `pre_restore` are exempt):
 *   - Keep ALL versions younger than 30 days.
 *   - For versions aged 30 to 90 days: keep one per calendar day (UTC).
 *   - For versions older than 90 days: keep one per calendar month (UTC).
 *
 * Within a bucket we keep the NEWEST row and delete the rest.
 *
 * v1 status: not yet wired into any endpoint. The brief permits deferring
 * lazy cleanup and we have. Callers can opt in by `await`ing this from a
 * versions.get handler once observed storage growth justifies the per-list
 * cost.
 */
export async function cleanupOldVersions(docId: number): Promise<number> {
  const db = useDb()

  const rows = await db
    .select({
      id: documentVersions.id,
      createdAt: documentVersions.createdAt,
      reason: documentVersions.reason,
    })
    .from(documentVersions)
    .where(eq(documentVersions.docId, docId))

  const now = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  const RECENT_CUTOFF = now - 30 * DAY_MS
  const OLD_CUTOFF = now - 90 * DAY_MS

  type Row = { id: number, createdAtMs: number }
  const buckets = new Map<string, Row[]>()

  const toDelete: number[] = []
  for (const r of rows) {
    // Never touch manual snapshots or pre-restore safety nets.
    if (r.reason !== 'autosave_snapshot') continue

    const ms = r.createdAt instanceof Date
      ? r.createdAt.getTime()
      : new Date(r.createdAt as unknown as string).getTime()

    if (ms >= RECENT_CUTOFF) continue // < 30 days: keep all

    const d = new Date(ms)
    const key = ms >= OLD_CUTOFF
      // 30-90 days: bucket per UTC day
      ? `d:${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
      // > 90 days: bucket per UTC month
      : `m:${d.getUTCFullYear()}-${d.getUTCMonth()}`

    let list = buckets.get(key)
    if (!list) {
      list = []
      buckets.set(key, list)
    }
    list.push({ id: r.id, createdAtMs: ms })
  }

  for (const list of buckets.values()) {
    if (list.length <= 1) continue
    // Keep newest, delete the rest.
    list.sort((a, b) => b.createdAtMs - a.createdAtMs)
    for (let i = 1; i < list.length; i++) {
      const item = list[i]
      if (item) toDelete.push(item.id)
    }
  }

  if (toDelete.length === 0) return 0

  await db
    .delete(documentVersions)
    .where(and(
      eq(documentVersions.docId, docId),
      inArray(documentVersions.id, toDelete),
    ))

  return toDelete.length
}
