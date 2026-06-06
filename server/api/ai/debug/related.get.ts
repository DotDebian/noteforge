import { eq, inArray, or } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { isVecAvailable, useDb } from '~/server/database/client'
import {
  docAnalyses,
  docChunks,
  docLinks,
  documents,
  workspaces,
  workspaceShares,
  type Workspace,
} from '~/server/database/schema'
import {
  decryptAnalysis,
  decryptDocument,
  decryptWorkspace,
} from '~/server/utils/encrypted-entities'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'
import { bufferToFloats, cosineSimilarity, loadEmbedding, meanVector } from '~/server/utils/vector'

/**
 * Related-notes diagnostics dump — everything needed to debug "why does doc X
 * show up as related to everything at ~75%?" in ONE copy-paste:
 *
 *   - per-doc embedding state (summary embedding present? dim? norm? chunks?)
 *   - analysis metadata (tags, summary lengths, staleness vs current markdown)
 *   - the FULL pairwise summary-cosine matrix + distribution stats
 *   - a faithful re-simulation of `GET /api/ai/related/:docId` for every
 *     active doc (same Path A/B, TAG_WEIGHT, LINK_BONUS, TOP_K)
 *
 * Mirrors the scoring in [related/[docId].get.ts] — keep the constants in
 * sync if that endpoint changes. Read-only; session-authenticated.
 */

/* Constants mirrored from `ai/related/[docId].get.ts` — keep in sync. */
const TOP_K = 5
const TAG_WEIGHT = 0.15
const LINK_BONUS = 0.1
/** Hard cap on the pairwise list size to keep the payload pasteable. */
const PAIR_LIMIT = 4000

interface PairEntry { a: number, b: number, cosine: number }

interface SimHit {
  docId: number
  title: string
  /** 'summary' = Path A (summary embedding), 'chunks' = Path B fallback. */
  path: 'summary' | 'chunks'
  cosine: number
  tagJaccard: number
  tagBonus: number
  linkBonus: number
  finalScore: number
  /** What the UI shows today: round(finalScore × 100). */
  displayedPercent: number
}

function l2norm(v: number[]): number {
  let acc = 0
  for (const x of v) acc += x * x
  return Math.sqrt(acc)
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return round(sorted[idx] ?? 0)
}

function cosineStats(values: number[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return {
    count: values.length,
    min: percentile(sorted, 0),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    max: percentile(sorted, 100),
    mean: round(mean),
  }
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const db = useDb()

  /* ---- Workspaces the user can see (owned + shared) ---------------------- */
  const owned = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerId, user.id))
  const sharedRows = await db
    .select({ workspace: workspaces })
    .from(workspaceShares)
    .innerJoin(workspaces, eq(workspaces.id, workspaceShares.workspaceId))
    .where(eq(workspaceShares.userId, user.id))

  const wsById = new Map<number, Workspace>()
  for (const w of owned) wsById.set(w.id, w)
  for (const s of sharedRows) wsById.set(s.workspace.id, s.workspace)

  const workspaceReports = []

  for (const ws of wsById.values()) {
    /* Resolve the content key (DEK for solo, WEK for shared). */
    let key: Buffer | null = null
    let keyError: string | null = null
    try {
      key = await getWorkspaceKeyFromWorkspace(event, ws)
    }
    catch (err) {
      keyError = (err as Error).message ?? 'key resolution failed'
    }

    const wsName = decryptWorkspace({ name: ws.name }, key).name ?? ''

    /* ---- Raw rows --------------------------------------------------------- */
    const docRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        markdown: documents.markdown,
        folderId: documents.folderId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        deletedAt: documents.deletedAt,
      })
      .from(documents)
      .where(eq(documents.workspaceId, ws.id))

    const docIds = docRows.map(d => d.id)
    const analysisRows = docIds.length > 0
      ? await db
          .select({
            docId: docAnalyses.docId,
            summaryShort: docAnalyses.summaryShort,
            summaryLong: docAnalyses.summaryLong,
            tags: docAnalyses.tags,
            language: docAnalyses.language,
            generatedAt: docAnalyses.generatedAt,
            markdownLengthAtAnalysis: docAnalyses.markdownLengthAtAnalysis,
            summaryEmbedding: docAnalyses.summaryEmbedding,
          })
          .from(docAnalyses)
          .where(inArray(docAnalyses.docId, docIds))
      : []

    const chunkRows = docIds.length > 0
      ? await db
          .select({
            docId: docChunks.docId,
            embedding: docChunks.embedding,
            embeddingBlob: docChunks.embeddingBlob,
          })
          .from(docChunks)
          .where(inArray(docChunks.docId, docIds))
      : []

    const linkRows = docIds.length > 0
      ? await db
          .select({ source: docLinks.sourceDocId, target: docLinks.targetDocId })
          .from(docLinks)
          .where(or(
            inArray(docLinks.sourceDocId, docIds),
            inArray(docLinks.targetDocId, docIds),
          ))
      : []

    /* ---- Index per doc ----------------------------------------------------- */
    const analysisByDoc = new Map(analysisRows.map(r => [r.docId, r] as const))
    const chunkVecsByDoc = new Map<number, number[][]>()
    const chunkCountByDoc = new Map<number, number>()
    for (const c of chunkRows) {
      chunkCountByDoc.set(c.docId, (chunkCountByDoc.get(c.docId) ?? 0) + 1)
      const vec = loadEmbedding({ embeddingBlob: c.embeddingBlob, embedding: c.embedding })
      if (vec.length === 0) continue
      const list = chunkVecsByDoc.get(c.docId)
      if (list) list.push(vec)
      else chunkVecsByDoc.set(c.docId, [vec])
    }

    const summaryVecByDoc = new Map<number, number[]>()
    for (const a of analysisRows) {
      if (!a.summaryEmbedding) continue
      const vec = bufferToFloats(a.summaryEmbedding)
      if (vec.length > 0) summaryVecByDoc.set(a.docId, vec)
    }

    const titleByDoc = new Map<number, string>()
    const tagsByDoc = new Map<number, Set<string>>()

    /* ---- Per-document report ----------------------------------------------- */
    const docReports = docRows.map((d) => {
      const decrypted = decryptDocument({ id: d.id, title: d.title, markdown: d.markdown }, key)
      const title = decrypted.title ?? ''
      titleByDoc.set(d.id, title)
      const markdownLength = (decrypted.markdown ?? '').length

      const a = analysisByDoc.get(d.id)
      const decA = a
        ? decryptAnalysis({
            summaryShort: a.summaryShort,
            summaryLong: a.summaryLong,
            tags: a.tags ?? [],
          }, key)
        : null
      tagsByDoc.set(d.id, new Set(decA?.tags ?? []))

      const summaryVec = summaryVecByDoc.get(d.id)
      const chunkVecs = chunkVecsByDoc.get(d.id) ?? []

      return {
        id: d.id,
        title,
        trashed: d.deletedAt != null,
        folderId: d.folderId,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        markdownLength,
        chunkCount: chunkCountByDoc.get(d.id) ?? 0,
        embeddedChunkCount: chunkVecs.length,
        chunkEmbeddingDim: chunkVecs[0]?.length ?? null,
        analysis: a
          ? {
              generatedAt: a.generatedAt,
              language: a.language,
              markdownLengthAtAnalysis: a.markdownLengthAtAnalysis,
              /** >0 = doc grew since last analysis; <0 = shrank. */
              staleByChars: a.markdownLengthAtAnalysis != null
                ? markdownLength - a.markdownLengthAtAnalysis
                : null,
              summaryShort: decA?.summaryShort ?? '',
              summaryShortLength: (decA?.summaryShort ?? '').length,
              summaryLongLength: (decA?.summaryLong ?? '').length,
              tags: decA?.tags ?? [],
              summaryEmbedding: summaryVec
                ? { present: true, dim: summaryVec.length, l2norm: round(l2norm(summaryVec)) }
                : { present: false, dim: null, l2norm: null },
            }
          : null,
        /** Which query-vector path `loadQueryVector` would take for this doc. */
        queryVectorSource: summaryVec
          ? 'summary' as const
          : chunkVecs.length > 0 ? 'chunk-mean' as const : 'none' as const,
      }
    })

    const activeDocs = docReports.filter(d => !d.trashed)
    const activeIds = new Set(activeDocs.map(d => d.id))

    /* ---- Pairwise summary-cosine matrix (active docs, Path A only) --------- */
    const pairDocs = activeDocs.filter(d => summaryVecByDoc.has(d.id)).map(d => d.id)
    const pairs: PairEntry[] = []
    for (let i = 0; i < pairDocs.length; i++) {
      const idA = pairDocs[i]
      if (idA == null) continue
      const vecA = summaryVecByDoc.get(idA)
      if (!vecA) continue
      for (let j = i + 1; j < pairDocs.length; j++) {
        const idB = pairDocs[j]
        if (idB == null) continue
        const vecB = summaryVecByDoc.get(idB)
        if (!vecB) continue
        pairs.push({ a: idA, b: idB, cosine: round(cosineSimilarity(vecA, vecB)) })
      }
    }
    pairs.sort((x, y) => y.cosine - x.cosine)
    const pairsTruncated = pairs.length > PAIR_LIMIT

    /* ---- Doc-link graph ----------------------------------------------------- */
    const linkedPairs = new Set<string>()
    for (const l of linkRows) {
      linkedPairs.add(`${l.source}->${l.target}`)
    }
    function isLinked(a: number, b: number): boolean {
      return linkedPairs.has(`${a}->${b}`) || linkedPairs.has(`${b}->${a}`)
    }

    /* ---- Faithful re-simulation of the related endpoint per active doc ----- */
    const relatedSimulation = activeDocs.map((queryDoc) => {
      // loadQueryVector: summary embedding, else mean of own chunks.
      const queryVec = summaryVecByDoc.get(queryDoc.id)
        ?? meanVector(chunkVecsByDoc.get(queryDoc.id) ?? [])
      if (queryVec.length === 0) {
        return { docId: queryDoc.id, title: queryDoc.title, queryVectorSource: queryDoc.queryVectorSource, hits: [] as SimHit[] }
      }

      const queryTags = tagsByDoc.get(queryDoc.id) ?? new Set<string>()
      const hits: SimHit[] = []
      for (const cand of activeDocs) {
        if (cand.id === queryDoc.id || !activeIds.has(cand.id)) continue

        // Path A: candidate summary embedding; Path B: max-of-chunks.
        let cosine: number
        let path: 'summary' | 'chunks'
        const candSummaryVec = summaryVecByDoc.get(cand.id)
        if (candSummaryVec) {
          cosine = cosineSimilarity(queryVec, candSummaryVec)
          path = 'summary'
        }
        else {
          const candChunks = chunkVecsByDoc.get(cand.id) ?? []
          if (candChunks.length === 0) continue
          cosine = Math.max(...candChunks.map(v => cosineSimilarity(queryVec, v)))
          path = 'chunks'
        }

        const tagJaccard = jaccard(queryTags, tagsByDoc.get(cand.id) ?? new Set())
        const linkBonus = isLinked(queryDoc.id, cand.id) ? LINK_BONUS : 0
        const finalScore = cosine + TAG_WEIGHT * tagJaccard + linkBonus
        hits.push({
          docId: cand.id,
          title: cand.title,
          path,
          cosine: round(cosine),
          tagJaccard: round(tagJaccard),
          tagBonus: round(TAG_WEIGHT * tagJaccard),
          linkBonus,
          finalScore: round(finalScore),
          displayedPercent: Math.round(finalScore * 100),
        })
      }
      hits.sort((x, y) => y.finalScore - x.finalScore)
      return {
        docId: queryDoc.id,
        title: queryDoc.title,
        queryVectorSource: queryDoc.queryVectorSource,
        hits: hits.slice(0, TOP_K),
      }
    })

    workspaceReports.push({
      id: ws.id,
      name: wsName,
      encryptionMode: ws.encryptionMode,
      keyError,
      counts: {
        docs: docReports.length,
        activeDocs: activeDocs.length,
        trashedDocs: docReports.length - activeDocs.length,
        docsWithAnalysis: docReports.filter(d => d.analysis != null).length,
        docsWithSummaryEmbedding: pairDocs.length,
        chunksTotal: chunkRows.length,
        chunksEmbedded: [...chunkVecsByDoc.values()].reduce((s, v) => s + v.length, 0),
        docLinks: linkRows.length,
      },
      documents: docReports,
      docLinks: linkRows,
      pairwiseSummaryCosines: {
        stats: cosineStats(pairs.map(p => p.cosine)),
        truncated: pairsTruncated,
        pairs: pairsTruncated ? pairs.slice(0, PAIR_LIMIT) : pairs,
      },
      relatedSimulation,
    })
  }

  return {
    report: {
      kind: 'noteforge-related-debug',
      version: 1,
      generatedAt: new Date().toISOString(),
      userId: user.id,
      runtime: {
        vecAvailable: isVecAvailable(),
        embedModel: 'mistral-embed',
        embedDim: 1024,
        summaryEmbeddingComposition: 'title + summaryShort + summaryLong + tags.join(", ") joined by \\n\\n',
      },
      scoringConstants: {
        TOP_K,
        TAG_WEIGHT,
        LINK_BONUS,
        minScoreThreshold: null,
        uiScoreFormula: 'round(finalScore * 100) — raw cosine, not renormalised',
      },
      workspaces: workspaceReports,
    },
  }
})
