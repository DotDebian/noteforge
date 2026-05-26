import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getRawDb, useDb } from '~/server/database/client'
import { docLinks, documents } from '~/server/database/schema'

/**
 * Match the internal doc-route shape `/w/:workspaceId/d/:docId`. Anchored so
 * we don't accidentally pick up a longer path segment (e.g. `/w/1/d/2/x`).
 *
 * Sprint 4 / F2.
 */
const DOC_LINK_RE = /\/w\/(\d+)\/d\/(\d+)(?=$|[/?#\s)"'<])/g

/**
 * Extract candidate target doc IDs from a markdown blob. Only links that
 * point to the *current* workspace are returned. The result is deduped but
 * NOT filtered against the database — callers should rely on
 * `reconcileDocLinks` to drop links whose target no longer exists or has
 * moved workspaces.
 *
 * Self-links (md → md) are NOT excluded here; callers that don't want them
 * (the reconciler does) should filter the array themselves.
 */
export function extractDocLinks(
  markdown: string,
  currentWorkspaceId: number,
): number[] {
  const out = new Set<number>()
  // Reset lastIndex defensively — the regex literal is module-scoped and `g`
  // flag carries state across calls.
  DOC_LINK_RE.lastIndex = 0
  for (const match of markdown.matchAll(DOC_LINK_RE)) {
    const wsRaw = match[1]
    const docRaw = match[2]
    if (!wsRaw || !docRaw) continue
    const ws = Number(wsRaw)
    const doc = Number(docRaw)
    if (!Number.isInteger(ws) || !Number.isInteger(doc)) continue
    if (ws !== currentWorkspaceId) continue
    out.add(doc)
  }
  return [...out]
}

/**
 * Reconcile the `doc_links` rows for `sourceDocId` to exactly match the
 * supplied target list:
 *   - Targets that don't exist in `documents` (or have been soft-deleted, or
 *     live in a different workspace) are filtered out.
 *   - Self-links (target === source) are filtered out.
 *   - The old set is wiped and the new set inserted atomically.
 *
 * Wrapped in a better-sqlite3 transaction so a partial failure doesn't leave
 * the table half-updated.
 */
export async function reconcileDocLinks(
  sourceDocId: number,
  targetDocIds: number[],
): Promise<void> {
  const db = useDb()

  // Resolve the source's workspace once so we can scope the validity check.
  const [source] = await db
    .select({ id: documents.id, workspaceId: documents.workspaceId })
    .from(documents)
    .where(eq(documents.id, sourceDocId))
    .limit(1)
  if (!source) return

  const candidates = targetDocIds.filter(id => id !== sourceDocId)

  let valid: number[] = []
  if (candidates.length > 0) {
    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(
        inArray(documents.id, candidates),
        eq(documents.workspaceId, source.workspaceId),
        isNull(documents.deletedAt),
      ))
    valid = rows.map(r => r.id)
  }

  // Apply delete+insert atomically. Drizzle's better-sqlite3 driver doesn't
  // expose a sync transaction wrapper around its query builder, but the raw
  // sqlite handle's `.transaction()` works because we drop down to prepared
  // statements that mirror the schema 1:1.
  const sqlite = getRawDb()
  const del = sqlite.prepare<[number]>(
    'DELETE FROM doc_links WHERE source_doc_id = ?',
  )
  const ins = sqlite.prepare<[number, number]>(
    'INSERT OR IGNORE INTO doc_links (source_doc_id, target_doc_id) VALUES (?, ?)',
  )
  const tx = sqlite.transaction((targets: number[]) => {
    del.run(sourceDocId)
    for (const t of targets) ins.run(sourceDocId, t)
  })
  tx(valid)
}
