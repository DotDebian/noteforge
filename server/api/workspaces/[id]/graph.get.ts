/**
 * GET /api/workspaces/:id/graph
 *
 * Returns nodes + edges for the workspace graph view.
 *  - nodes: every active doc in the workspace
 *  - edges of kind `link`: from `doc_links` (markdown-link backlinks)
 *  - edges of kind `tag`: between docs sharing >= 1 tag
 *
 * Tag-edge pruning: for workspaces with > 50 docs we only emit edges using
 * the top-3 most-frequent tags to keep the graph readable. We also
 * de-duplicate edges (no self-edges, no double edges in opposite
 * directions for `tag`).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses, docLinks, documents } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { getDek } from '~/server/utils/dek'
import { decryptAnalysis, decryptDocument } from '~/server/utils/encrypted-entities'

export interface GraphNode {
  id: number
  title: string
  folderId: number | null
  tags: string[]
}

export interface GraphEdge {
  source: number
  target: number
  kind: 'link' | 'tag'
  /** Shared tag for `tag` edges — useful for the side panel. */
  tag?: string
}

const TAG_EDGE_PRUNE_THRESHOLD = 50
const TOP_TAGS_WHEN_LARGE = 3

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  await assertWorkspaceAccess(event, workspaceId)
  const dek = await getDek(event)

  const db = useDb()

  /* ---------- nodes ---------- */
  const docs = await db
    .select({
      id: documents.id,
      title: documents.title,
      folderId: documents.folderId,
    })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), activeDocsWhere()))

  if (docs.length === 0) {
    return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] }
  }

  const docIds = docs.map(d => d.id)
  const docIdSet = new Set(docIds)

  /* ---------- tags per doc ---------- */
  const analyses = await db
    .select({ docId: docAnalyses.docId, tags: docAnalyses.tags })
    .from(docAnalyses)
    .where(inArray(docAnalyses.docId, docIds))

  const tagsByDoc = new Map<number, string[]>()
  for (const a of analyses) {
    const decTags = decryptAnalysis({ tags: Array.isArray(a.tags) ? a.tags : [] }, dek).tags ?? []
    const t = decTags.filter(x => typeof x === 'string' && x.length > 0)
    tagsByDoc.set(a.docId, t.map(x => x.toLowerCase()))
  }

  const nodes: GraphNode[] = docs.map(d => ({
    id: d.id,
    title: decryptDocument({ title: d.title }, dek).title ?? '',
    folderId: d.folderId,
    tags: tagsByDoc.get(d.id) ?? [],
  }))

  /* ---------- link edges from doc_links ---------- */
  const links = await db
    .select({ source: docLinks.sourceDocId, target: docLinks.targetDocId })
    .from(docLinks)
    .where(inArray(docLinks.sourceDocId, docIds))

  const edges: GraphEdge[] = []
  const linkSeen = new Set<string>()
  for (const l of links) {
    if (!docIdSet.has(l.target)) continue
    if (l.source === l.target) continue
    const key = `${l.source}->${l.target}|link`
    if (linkSeen.has(key)) continue
    linkSeen.add(key)
    edges.push({ source: l.source, target: l.target, kind: 'link' })
  }

  /* ---------- tag edges ---------- */
  // Count tag frequency across active docs.
  const tagCount = new Map<string, number>()
  for (const tags of tagsByDoc.values()) {
    const inner = new Set(tags)
    for (const tag of inner) {
      tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
    }
  }

  // For large workspaces, restrict tag edges to top-N tags by frequency.
  const isLarge = docs.length > TAG_EDGE_PRUNE_THRESHOLD
  let allowedTags: Set<string> | null = null
  if (isLarge) {
    const sorted = Array.from(tagCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TAGS_WHEN_LARGE)
      .map(t => t[0])
    allowedTags = new Set(sorted)
  }

  // Build inverted index: tag -> docIds.
  const docsByTag = new Map<string, number[]>()
  for (const [docId, tags] of tagsByDoc) {
    for (const tag of new Set(tags)) {
      if (allowedTags && !allowedTags.has(tag)) continue
      if (!docsByTag.has(tag)) docsByTag.set(tag, [])
      docsByTag.get(tag)!.push(docId)
    }
  }

  // Emit at most one tag-edge per unordered (a, b) pair across the whole
  // graph; pick the first matching tag we hit. This keeps the edge count
  // bounded at roughly O(n²) worst case (still acceptable for < 500 docs).
  const tagPairSeen = new Set<string>()
  for (const [tag, ids] of docsByTag) {
    if (ids.length < 2) continue
    // Skip globally noisy tags that connect more than 25 docs — they
    // create a hairball that nukes layout quality.
    if (ids.length > 25) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!
        const b = ids[j]!
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        const key = `${lo}-${hi}`
        if (tagPairSeen.has(key)) continue
        tagPairSeen.add(key)
        edges.push({ source: a, target: b, kind: 'tag', tag })
      }
    }
  }

  return { nodes, edges }
})
