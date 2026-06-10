/**
 * GET /api/workspaces/:id/graph
 *
 * Returns nodes + edges for the workspace graph view.
 *  - nodes: every active doc in the workspace
 *  - edges of kind `link`:    from `doc_links` (markdown / wiki backlinks)
 *  - edges of kind `tag`:     between docs sharing >= 1 (non-noisy) tag
 *  - edges of kind `similar`: semantic kNN over `doc_analyses.summary_embedding`
 *                             (same signal as the "related notes" panel) — this
 *                             is what keeps the graph connected when a workspace
 *                             has few wiki-links and many one-off tags.
 *
 * Pair de-dup is layered by priority: link > tag > similar. A pair already
 * joined by a stronger edge never gets a redundant weaker one, so the graph
 * stays readable. Globally-noisy tags (on too many docs) are skipped to avoid
 * a hairball, and the O(n²) similarity pass is capped to mid-size workspaces.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses, docChunks, docLinks, documents } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { getDek } from '~/server/utils/dek'
import { decryptAnalysis, decryptDocument } from '~/server/utils/encrypted-entities'
import { bufferToFloats, cosineSimilarity, loadEmbedding, meanVector } from '~/server/utils/vector'

export interface GraphNode {
  id: number
  title: string
  folderId: number | null
  tags: string[]
}

export interface GraphEdge {
  source: number
  target: number
  kind: 'link' | 'tag' | 'similar'
  /** Shared tag for `tag` edges — useful for the side panel. */
  tag?: string
  /** Strength signal: cosine for `similar`, shared-tag count for `tag`. */
  weight?: number
}

/** A tag joining more docs than this is a category, not a relationship — skip it. */
const TAG_NOISY_MAX = 22
/** Cap the semantic O(n²) pass to mid-size workspaces (each pair is a 1024-dim cosine). */
const SIMILARITY_MAX_DOCS = 800
/** Max semantic neighbours kept per node (asymmetric kNN, de-duped to undirected). */
const SIMILARITY_TOP_K = 4
/**
 * Cosine floor for a semantic edge. `mistral-embed` is anisotropic (unrelated
 * French summaries already sit ~0.73-0.76), so we floor a touch above the
 * related-panel MIN_COSINE (0.77) to keep graph edges meaningful.
 */
const SIMILARITY_MIN_COSINE = 0.78

function undirectedKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

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

  /* ---------- tags + summary embeddings per doc ---------- */
  const analyses = await db
    .select({
      docId: docAnalyses.docId,
      tags: docAnalyses.tags,
      summaryEmbedding: docAnalyses.summaryEmbedding,
    })
    .from(docAnalyses)
    .where(inArray(docAnalyses.docId, docIds))

  const tagsByDoc = new Map<number, string[]>()
  const vecByDoc = new Map<number, number[]>()
  for (const a of analyses) {
    const decTags = decryptAnalysis({ tags: Array.isArray(a.tags) ? a.tags : [] }, dek).tags ?? []
    const t = decTags.filter(x => typeof x === 'string' && x.length > 0)
    tagsByDoc.set(a.docId, t.map(x => x.toLowerCase()))
    if (a.summaryEmbedding) {
      const v = bufferToFloats(a.summaryEmbedding)
      if (v.length > 0) vecByDoc.set(a.docId, v)
    }
  }

  const nodes: GraphNode[] = docs.map(d => ({
    id: d.id,
    title: decryptDocument({ title: d.title }, dek).title ?? '',
    folderId: d.folderId,
    tags: tagsByDoc.get(d.id) ?? [],
  }))

  const edges: GraphEdge[] = []
  // Undirected dedup shared across edge kinds — a pair joined by a stronger
  // edge (link > tag > similar) is never re-joined by a weaker one.
  const connectedPair = new Set<string>()

  /* ---------- link edges (doc_links) — strongest signal ---------- */
  const links = await db
    .select({ source: docLinks.sourceDocId, target: docLinks.targetDocId })
    .from(docLinks)
    .where(inArray(docLinks.sourceDocId, docIds))

  const linkSeen = new Set<string>()
  for (const l of links) {
    if (!docIdSet.has(l.target)) continue
    if (l.source === l.target) continue
    const dirKey = `${l.source}->${l.target}`
    if (linkSeen.has(dirKey)) continue
    linkSeen.add(dirKey)
    edges.push({ source: l.source, target: l.target, kind: 'link' })
    connectedPair.add(undirectedKey(l.source, l.target))
  }

  /* ---------- tag edges (shared, non-noisy tag) ---------- */
  // Inverted index: tag -> docIds. Skip globally-noisy tags (a category that
  // would otherwise wire up dozens of docs into a hairball).
  const docsByTag = new Map<string, number[]>()
  for (const [docId, tags] of tagsByDoc) {
    for (const tag of new Set(tags)) {
      if (!docsByTag.has(tag)) docsByTag.set(tag, [])
      docsByTag.get(tag)!.push(docId)
    }
  }

  // Shared-tag count per pair, so the graph can weight a 3-tag overlap above a
  // 1-tag one. One edge per pair, labelled with the first shared tag we hit.
  const tagPairs = new Map<string, { a: number, b: number, weight: number, tag: string }>()
  for (const [tag, ids] of docsByTag) {
    if (ids.length < 2 || ids.length > TAG_NOISY_MAX) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!
        const b = ids[j]!
        const key = undirectedKey(a, b)
        if (connectedPair.has(key)) continue // already linked — stronger edge wins
        const existing = tagPairs.get(key)
        if (existing) existing.weight++
        else tagPairs.set(key, { a, b, weight: 1, tag })
      }
    }
  }
  for (const [key, p] of tagPairs) {
    connectedPair.add(key)
    edges.push({ source: p.a, target: p.b, kind: 'tag', tag: p.tag, weight: p.weight })
  }

  /* ---------- similar edges (summary-embedding kNN) ---------- */
  // Fill missing vectors with the mean of a doc's chunk embeddings so docs
  // analysed before summary-embeddings still participate.
  const missingVec = docIds.filter(id => !vecByDoc.has(id))
  if (missingVec.length > 0 && docs.length <= SIMILARITY_MAX_DOCS) {
    const chunkRows = await db
      .select({
        docId: docChunks.docId,
        embedding: docChunks.embedding,
        embeddingBlob: docChunks.embeddingBlob,
      })
      .from(docChunks)
      .where(inArray(docChunks.docId, missingVec))
    const chunksByDoc = new Map<number, number[][]>()
    for (const c of chunkRows) {
      const v = loadEmbedding({ embeddingBlob: c.embeddingBlob, embedding: c.embedding })
      if (v.length === 0) continue
      if (!chunksByDoc.has(c.docId)) chunksByDoc.set(c.docId, [])
      chunksByDoc.get(c.docId)!.push(v)
    }
    for (const [id, vs] of chunksByDoc) {
      const m = meanVector(vs)
      if (m.length > 0) vecByDoc.set(id, m)
    }
  }

  if (docs.length <= SIMILARITY_MAX_DOCS) {
    const simIds = Array.from(vecByDoc.keys())
    for (const a of simIds) {
      const va = vecByDoc.get(a)!
      const neighbours: Array<{ id: number, score: number }> = []
      for (const b of simIds) {
        if (b === a) continue
        const score = cosineSimilarity(va, vecByDoc.get(b)!)
        if (score < SIMILARITY_MIN_COSINE) continue
        neighbours.push({ id: b, score })
      }
      neighbours.sort((x, y) => y.score - x.score)
      for (const n of neighbours.slice(0, SIMILARITY_TOP_K)) {
        const key = undirectedKey(a, n.id)
        if (connectedPair.has(key)) continue
        connectedPair.add(key)
        edges.push({ source: a, target: n.id, kind: 'similar', weight: n.score })
      }
    }
  }

  return { nodes, edges }
})
