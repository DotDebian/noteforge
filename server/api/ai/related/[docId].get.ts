import { and, eq, isNotNull, inArray, ne, or } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses, docChunks, docLinks, documents } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { decryptField } from '~/server/utils/crypto'
import { getWorkspaceKey } from '~/server/utils/workspace-key'
import {
  decryptAnalysis,
  decryptChunkText,
  decryptDocument,
} from '~/server/utils/encrypted-entities'
import {
  jaccard,
  LINK_BONUS,
  MIN_COSINE,
  TAG_WEIGHT,
  TOP_K,
} from '~/server/utils/related-scoring'
import { bufferToFloats, cosineSimilarity, loadEmbedding, meanVector } from '~/server/utils/vector'

interface RelatedHit {
  docId: number
  title: string
  score: number
  snippet: string
}

const SNIPPET_MAX = 240

function makeSnippet(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= SNIPPET_MAX) return cleaned
  return `${cleaned.slice(0, SNIPPET_MAX - 1).trimEnd()}…`
}

/**
 * Related-notes scoring.
 *
 * Preferred path — DOC-LEVEL summary embeddings:
 *   At analyze time we embed each doc's `title + summary + tags` via
 *   `mistral-embed` and store the resulting vector on `doc_analyses.
 *   summary_embedding`. This endpoint compares the current doc's summary
 *   vector against every other doc's summary vector.
 *
 * Fallback path — for docs without a `summary_embedding` yet: max-of-chunks
 *   cosine — the single best-matching chunk is the doc's representative
 *   (a mean would dilute the signal across boilerplate paragraphs).
 *
 * Candidates whose raw cosine sits below MIN_COSINE are dropped entirely —
 * mistral-embed's anisotropy puts unrelated docs at ~0.73-0.76 already, so
 * without the floor the panel fills with noise (see related-scoring.ts).
 *
 * On top of the cosine score we add two non-semantic signals (only when
 * tag / link data is available):
 *   - Jaccard tag overlap × TAG_WEIGHT
 *   - Flat bonus for explicit doc-links in either direction
 */
export default defineEventHandler(async (event) => {
  const docId = parseIdParam(event, 'docId')
  const doc = await assertDocumentAccess(event, docId)
  // Candidates are all in `doc.workspaceId`, so one workspace key (DEK for
  // solo, WEK for shared) decrypts every title / summary / chunk below.
  const dek = await getWorkspaceKey(event, doc.workspaceId)

  const db = useDb()

  // Build the query vector — prefer the summary embedding when present.
  const queryVec = await loadQueryVector(docId)
  if (queryVec.length === 0) return [] as RelatedHit[]

  // Candidate documents in the same workspace, excluding self + trash.
  const candidateDocs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(
      eq(documents.workspaceId, doc.workspaceId),
      ne(documents.id, docId),
      activeDocsWhere(),
    ))
  if (candidateDocs.length === 0) return [] as RelatedHit[]
  const candidateIds = candidateDocs.map(d => d.id)
  const titleById = new Map(
    candidateDocs.map(d => [d.id, decryptDocument({ title: d.title }, dek).title ?? ''] as const),
  )

  /* ---- Tag metadata (query doc + candidates) ----------------------------- */
  const [queryAnalysis] = await db
    .select({ tags: docAnalyses.tags })
    .from(docAnalyses)
    .where(eq(docAnalyses.docId, docId))
    .limit(1)
  const queryTags = new Set<string>(
    decryptAnalysis({ tags: queryAnalysis?.tags ?? [] }, dek).tags ?? [],
  )

  const candidateAnalyses = await db
    .select({
      docId: docAnalyses.docId,
      summaryEmbedding: docAnalyses.summaryEmbedding,
      summaryShort: docAnalyses.summaryShort,
      tags: docAnalyses.tags,
    })
    .from(docAnalyses)
    .where(inArray(docAnalyses.docId, candidateIds))

  const tagsByCandidate = new Map<number, Set<string>>(
    candidateAnalyses.map((r) => {
      const decTags = decryptAnalysis({ tags: r.tags ?? [] }, dek).tags ?? []
      return [r.docId, new Set<string>(decTags)] as const
    }),
  )

  /* ---- Doc-link graph (either direction counts) -------------------------- */
  const linkRows = await db
    .select({ source: docLinks.sourceDocId, target: docLinks.targetDocId })
    .from(docLinks)
    .where(or(eq(docLinks.sourceDocId, docId), eq(docLinks.targetDocId, docId)))
  const linkedDocs = new Set<number>()
  for (const r of linkRows) {
    if (r.source === docId) linkedDocs.add(r.target)
    if (r.target === docId) linkedDocs.add(r.source)
  }

  /* ---- Score candidates -------------------------------------------------- */
  const best = new Map<number, { score: number, snippet: string }>()

  // Path A: doc-to-doc summary embeddings (fast, no chunk scan).
  for (const row of candidateAnalyses) {
    const vec = row.summaryEmbedding ? bufferToFloats(row.summaryEmbedding) : []
    if (vec.length === 0) continue
    const score = cosineSimilarity(queryVec, vec)
    best.set(row.docId, {
      score,
      snippet: makeSnippet(decryptField(row.summaryShort || '', dek)),
    })
  }

  // Path B: chunk-based fallback for any candidate without a summary
  // embedding yet — max-of-chunks against the query vector.
  const fallbackIds = candidateIds.filter(id => !best.has(id))
  if (fallbackIds.length > 0) {
    const candidateChunks = await db
      .select({
        docId: docChunks.docId,
        text: docChunks.text,
        embedding: docChunks.embedding,
        embeddingBlob: docChunks.embeddingBlob,
      })
      .from(docChunks)
      .where(inArray(docChunks.docId, fallbackIds))

    for (const c of candidateChunks) {
      const vec = loadEmbedding({ embeddingBlob: c.embeddingBlob, embedding: c.embedding })
      if (vec.length === 0) continue
      const score = cosineSimilarity(queryVec, vec)
      const existing = best.get(c.docId)
      if (!existing || score > existing.score) {
        best.set(c.docId, { score, snippet: makeSnippet(decryptChunkText(c.text, dek)) })
      }
    }
  }

  /* ---- Combine with non-semantic boosts ---------------------------------- */
  const hits: RelatedHit[] = []
  for (const [otherDocId, { score: cosine, snippet }] of best) {
    const title = titleById.get(otherDocId)
    if (title == null) continue
    // Relevance floor on the RAW cosine — bonuses must not be able to push
    // a semantically-unrelated doc into the panel. See `related-scoring.ts`
    // for the calibration data behind the constant.
    if (cosine < MIN_COSINE) continue
    const tagOverlap = jaccard(queryTags, tagsByCandidate.get(otherDocId) ?? new Set())
    const linkBonus = linkedDocs.has(otherDocId) ? LINK_BONUS : 0
    const score = cosine + TAG_WEIGHT * tagOverlap + linkBonus
    hits.push({ docId: otherDocId, title, score, snippet })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, TOP_K)
})

/**
 * Resolve the query vector for the current doc, preferring the stored
 * summary embedding. Falls back to the mean of chunk embeddings when the
 * doc has no analysis or the column is still null.
 */
async function loadQueryVector(docId: number): Promise<number[]> {
  const db = useDb()

  const [analysis] = await db
    .select({ summaryEmbedding: docAnalyses.summaryEmbedding })
    .from(docAnalyses)
    .where(eq(docAnalyses.docId, docId))
    .limit(1)

  if (analysis?.summaryEmbedding) {
    const vec = bufferToFloats(analysis.summaryEmbedding)
    if (vec.length > 0) return vec
  }

  // Fallback: mean of own chunk embeddings.
  const ownChunks = await db
    .select({ embedding: docChunks.embedding, embeddingBlob: docChunks.embeddingBlob })
    .from(docChunks)
    .where(eq(docChunks.docId, docId))

  const vecs = ownChunks
    .map(c => loadEmbedding({ embeddingBlob: c.embeddingBlob, embedding: c.embedding }))
    .filter(v => v.length > 0)

  if (vecs.length === 0) return []
  return meanVector(vecs)
}
