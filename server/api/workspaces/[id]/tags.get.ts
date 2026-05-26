/**
 * GET /api/workspaces/:id/tags
 *
 * Returns the distinct set of tags currently produced by `doc_analyses.tags`
 * across the active (non-trashed) documents in this workspace, with the
 * matching doc ids and counts. Used by the workspace tags page.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses, documents } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { getDek } from '~/server/utils/dek'
import { decryptAnalysis } from '~/server/utils/encrypted-entities'

export interface TagAggregate {
  name: string
  count: number
  docIds: number[]
}

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  // assertWorkspaceAccess resolves the user via requireUser internally.
  await assertWorkspaceAccess(event, workspaceId)
  const dek = await getDek(event)

  const db = useDb()

  // Active documents in the workspace — id only, used both to scope the join
  // and to allow the analyses lookup to filter by doc id list.
  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), activeDocsWhere()))

  if (docs.length === 0) {
    return { tags: [] as TagAggregate[] }
  }

  const docIds = docs.map(d => d.id)

  const analyses = await db
    .select({ docId: docAnalyses.docId, tags: docAnalyses.tags })
    .from(docAnalyses)
    .where(inArray(docAnalyses.docId, docIds))

  // Aggregate by lower-case tag name to fold near-duplicates, but display the
  // first capitalisation we saw so the UI stays readable.
  const byKey = new Map<string, { display: string, count: number, docIds: Set<number> }>()

  for (const row of analyses) {
    // Tags are stored encrypted per-element; decrypt the array first.
    const tags = decryptAnalysis({ tags: row.tags ?? [] }, dek).tags ?? []
    if (!Array.isArray(tags) || tags.length === 0) continue
    // Within one document, a tag should only count once even if duplicated
    // in the analysis output.
    const seenInDoc = new Set<string>()
    for (const raw of tags) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      const key = trimmed.toLowerCase()
      if (seenInDoc.has(key)) continue
      seenInDoc.add(key)

      const existing = byKey.get(key)
      if (existing) {
        existing.count += 1
        existing.docIds.add(row.docId)
      }
      else {
        byKey.set(key, { display: trimmed, count: 1, docIds: new Set([row.docId]) })
      }
    }
  }

  const tags: TagAggregate[] = Array.from(byKey.values())
    .map(v => ({ name: v.display, count: v.count, docIds: Array.from(v.docIds).sort((a, b) => a - b) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.name.localeCompare(b.name)
    })

  return { tags }
})
