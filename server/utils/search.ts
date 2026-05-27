/**
 * Workspace-scoped chunk search — the shared retrieval primitive backing
 * both `chat.post.ts` (RAG context) and the `search_notes` MCP tool.
 *
 * Pipeline (default — hybrid):
 *   1. First-stage A: vec0 cosine MATCH oversampled to FIRST_STAGE_K (or
 *      JS-cosine when sqlite-vec is unavailable).
 *   2. First-stage B: FTS5 BM25 MATCH oversampled to FIRST_STAGE_K — catches
 *      proper nouns, acronyms, and rare terms that bi-encoder embeddings
 *      smooth away.
 *   3. Fusion: Reciprocal Rank Fusion (k=60) over the two ranked lists.
 *   4. Per-doc cap + top-K trim (cosine-only mode still applies MIN_SCORE;
 *      hybrid mode skips the threshold because FTS hits without a strong
 *      cosine match are still useful — the reranker downstream filters
 *      noise).
 *
 * `searchWorkspaceChunks` additionally runs the Mistral reranker over the
 * top-N candidates before returning, sharpening relevance for the MCP
 * `search_notes` tool. Chat is in charge of its own rerank step so it can
 * interleave it with query rewriting + history-aware re-embedding.
 *
 * Tunables:
 *   - MIN_SCORE       = 0.45  cosine threshold (vec-only path)
 *   - TOP_K           = 6     final results returned
 *   - PER_DOC         = 2     max hits per source document
 *   - FIRST_STAGE_K   = 30    per-modality oversampling before fusion
 *   - RRF_K           = 60    classic RRF constant
 *   - SNIPPET         = 1500  per-chunk text returned to callers
 */
import { and, eq, inArray } from 'drizzle-orm'
import { getRawDb, isVecAvailable, useDb } from '~/server/database/client'
import { docChunks } from '~/server/database/schema'
import { mistralEmbed } from './mistral'
import { bestSentence } from './best-sentence'
import { decryptChunkText } from './encrypted-entities'
import { cosineSimilarity, floatsToBuffer, loadEmbedding } from './vector'
import { rerankChunks } from './rerank'

/**
 * Encryption note — `doc_chunks.text` is ciphertext at rest. Every
 * retrieval path here decrypts via `decryptChunkText(..., dek)` BEFORE
 * returning to the caller (chat / search_notes), so reranker prompts,
 * snippet truncation, bestSentence highlighting and downstream UIs all
 * see plaintext. FTS5 still reads its own plaintext mirror — see
 * embed-doc.ts.
 */

export const SEARCH_TOP_K = 6
export const SEARCH_PER_DOC_CAP = 2
export const SEARCH_MIN_SCORE = 0.45
export const SEARCH_SNIPPET_MAX = 1500
const FIRST_STAGE_K = 30
const RRF_K = 60
const MAX_DISTANCE = 1 - SEARCH_MIN_SCORE

export interface ScoredChunk {
  docId: number
  idx: number
  text: string
  score: number
}

export interface SearchHit {
  docId: number
  idx: number
  /** Full chunk text (trimmed/truncated to SEARCH_SNIPPET_MAX). */
  snippet: string
  /** Best-matching sentence inside the chunk relative to the query. */
  highlight: string
  /** Final relevance score in [0, 1]. */
  score: number
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= n) return cleaned
  return `${cleaned.slice(0, n - 1).trimEnd()}…`
}

/* -------------------------------------------------------------------------- */
/*  First-stage retrieval — cosine                                             */
/* -------------------------------------------------------------------------- */

interface VecOptions {
  /** Drop hits whose cosine distance exceeds this threshold. */
  maxDistance?: number
  /** vec0 `k` parameter — how many neighbours to ask for. */
  k?: number
}

export async function retrieveViaVec0(
  candidateDocIds: number[],
  queryVec: number[],
  opts: VecOptions = {},
  dek: Buffer | null = null,
): Promise<ScoredChunk[]> {
  const db = useDb()
  const sqlite = getRawDb()
  const k = opts.k ?? FIRST_STAGE_K
  const maxDist = opts.maxDistance ?? MAX_DISTANCE

  const chunkRows = await db
    .select({ id: docChunks.id })
    .from(docChunks)
    .where(inArray(docChunks.docId, candidateDocIds))
  if (chunkRows.length === 0) return []
  const candidateChunkIds = chunkRows.map(r => r.id)

  const queryBuf = floatsToBuffer(queryVec)
  const matchStmt = sqlite.prepare<[Buffer, number], { chunk_id: number, distance: number }>(
    `SELECT chunk_id, distance
       FROM doc_chunks_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance`,
  )
  const matchRows = matchStmt.all(queryBuf, k)
  if (matchRows.length === 0) return []

  const candidateSet = new Set<number>(candidateChunkIds)
  const survivors = matchRows.filter(
    r => candidateSet.has(r.chunk_id) && r.distance <= maxDist,
  )
  if (survivors.length === 0) return []

  const rows = await db
    .select({
      id: docChunks.id,
      docId: docChunks.docId,
      idx: docChunks.idx,
      text: docChunks.text,
    })
    .from(docChunks)
    .where(inArray(docChunks.id, survivors.map(s => s.chunk_id)))

  const byId = new Map<number, { docId: number, idx: number, text: string }>(
    rows.map(r => [r.id, { docId: r.docId, idx: r.idx, text: decryptChunkText(r.text, dek) }] as const),
  )

  const scored: ScoredChunk[] = []
  for (const r of survivors) {
    const row = byId.get(r.chunk_id)
    if (!row) continue
    scored.push({
      docId: row.docId,
      idx: row.idx,
      text: row.text,
      score: 1 - r.distance,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

export async function retrieveViaJsCosine(
  candidateDocIds: number[],
  queryVec: number[],
  opts: { minScore?: number } = {},
  dek: Buffer | null = null,
): Promise<ScoredChunk[]> {
  const db = useDb()
  const minScore = opts.minScore ?? SEARCH_MIN_SCORE
  const rows = await db
    .select({
      docId: docChunks.docId,
      idx: docChunks.idx,
      text: docChunks.text,
      embedding: docChunks.embedding,
      embeddingBlob: docChunks.embeddingBlob,
    })
    .from(docChunks)
    .where(inArray(docChunks.docId, candidateDocIds))

  return rows
    .map((r): ScoredChunk | null => {
      const vec = loadEmbedding({ embeddingBlob: r.embeddingBlob, embedding: r.embedding })
      if (vec.length === 0) return null
      return {
        docId: r.docId,
        idx: r.idx,
        text: decryptChunkText(r.text, dek),
        score: cosineSimilarity(queryVec, vec),
      }
    })
    .filter((x): x is ScoredChunk => x !== null && x.score >= minScore)
    .sort((a, b) => b.score - a.score)
}

/* -------------------------------------------------------------------------- */
/*  First-stage retrieval — FTS5 BM25                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tokenize a free-text query into a safe FTS5 MATCH expression. We strip
 * everything that isn't a unicode letter or digit, drop short tokens
 * (length < 2), and OR-join the survivors after quoting them. Quoting makes
 * each token a literal phrase so accidental FTS5 operators (`NEAR`, `AND`,
 * column filters, `*`, `^`, `:`) are inert.
 *
 * Returns an empty string when no usable tokens survive — callers must skip
 * the BM25 path in that case (FTS5 errors on empty MATCH).
 */
function buildFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
  if (tokens.length === 0) return ''
  // Dedupe to keep the MATCH expression short.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    unique.push(t)
  }
  return unique.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

export async function retrieveViaFts(
  candidateDocIds: number[],
  queryText: string,
  opts: { limit?: number } = {},
  dek: Buffer | null = null,
): Promise<ScoredChunk[]> {
  if (candidateDocIds.length === 0) return []
  const matchExpr = buildFtsQuery(queryText)
  if (matchExpr.length === 0) return []

  const db = useDb()
  const sqlite = getRawDb()
  const limit = opts.limit ?? FIRST_STAGE_K

  // bm25() returns a negative number; lower = better. We pull rows ordered
  // ASC and convert to a positive "relevance" so it can sit next to cosine
  // in a single ScoredChunk shape.
  const ftsStmt = sqlite.prepare<[string, number], { rowid: number, bm25: number }>(
    `SELECT rowid, bm25(doc_chunks_fts) AS bm25
       FROM doc_chunks_fts
      WHERE doc_chunks_fts MATCH ?
      ORDER BY bm25 ASC
      LIMIT ?`,
  )

  let matches: { rowid: number, bm25: number }[]
  try {
    matches = ftsStmt.all(matchExpr, limit)
  }
  catch {
    // Malformed MATCH expressions surface as SQLITE errors. The quoting
    // strategy above should prevent this, but defend in depth — a failed
    // BM25 path simply means the hybrid degrades to vec-only.
    return []
  }
  if (matches.length === 0) return []

  const candidateSet = new Set(candidateDocIds)
  const rows = await db
    .select({
      id: docChunks.id,
      docId: docChunks.docId,
      idx: docChunks.idx,
      text: docChunks.text,
    })
    .from(docChunks)
    .where(and(
      inArray(docChunks.id, matches.map(m => m.rowid)),
      inArray(docChunks.docId, candidateDocIds),
    ))

  const byId = new Map<number, { docId: number, idx: number, text: string }>(
    rows.map(r => [r.id, { docId: r.docId, idx: r.idx, text: decryptChunkText(r.text, dek) }] as const),
  )

  // Best (most-negative) bm25 in this result set — we'll map onto [0, 1] so
  // the score is comparable in magnitude to cosine without being a real
  // probability. RRF doesn't need this — but having a non-NaN `score` keeps
  // downstream consumers (UI, MCP) happy.
  const bestBm25 = matches[0]?.bm25 ?? 0
  const worstBm25 = matches[matches.length - 1]?.bm25 ?? bestBm25
  const span = Math.max(1e-6, Math.abs(worstBm25 - bestBm25))

  const out: ScoredChunk[] = []
  for (const m of matches) {
    const row = byId.get(m.rowid)
    if (!row) continue
    if (!candidateSet.has(row.docId)) continue
    const normalised = 1 - Math.min(1, Math.abs(m.bm25 - bestBm25) / span)
    out.push({
      docId: row.docId,
      idx: row.idx,
      text: row.text,
      score: normalised,
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Fusion + ranking                                                           */
/* -------------------------------------------------------------------------- */

function chunkKey(c: { docId: number, idx: number }): string {
  return `${c.docId}:${c.idx}`
}

/**
 * Reciprocal Rank Fusion of N ranked lists. Each list is consumed in its
 * given order (best first). The returned list is sorted by combined RRF
 * score, with each chunk's `score` set to **the best per-modality score it
 * received** (cosine if vec hit it, normalised BM25 otherwise) — that lets
 * MIN_SCORE-style downstream gates keep working. Pass `RRF_K` to taste; the
 * default 60 is the value used by the original RRF paper.
 */
function reciprocalRankFusion(lists: ScoredChunk[][]): ScoredChunk[] {
  const rrfScore = new Map<string, number>()
  const merged = new Map<string, ScoredChunk>()

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]!
      const key = chunkKey(hit)
      const contribution = 1 / (RRF_K + rank + 1)
      rrfScore.set(key, (rrfScore.get(key) ?? 0) + contribution)
      const prior = merged.get(key)
      if (!prior || hit.score > prior.score) {
        merged.set(key, hit)
      }
    }
  }

  const out: { hit: ScoredChunk, rrf: number }[] = []
  for (const [key, hit] of merged) {
    out.push({ hit, rrf: rrfScore.get(key) ?? 0 })
  }
  out.sort((a, b) => b.rrf - a.rrf)
  return out.map(o => o.hit)
}

interface RankOptions {
  perDocCap?: number
  topK?: number
  /**
   * Optional natural-language query string. When supplied, retrieval runs
   * in hybrid mode (cosine + FTS5 BM25 fused via RRF). When omitted, only
   * cosine is consulted — preserves the legacy behaviour for callers that
   * don't have / don't want the raw query text.
   */
  queryText?: string
}

/**
 * Score chunks against a query vector and pick the top-K, capped per doc.
 * Caller controls the candidate set (workspace/folder/doc scoping is applied
 * upstream) and decides whether to enforce the per-doc cap (doc-scoped chat
 * skips it).
 *
 * Pass `queryText` to enable hybrid retrieval (recommended). Without it the
 * function falls back to the original cosine-only path.
 */
export async function rankChunks(
  candidateDocIds: number[],
  queryVec: number[],
  options: RankOptions = {},
  dek: Buffer | null = null,
): Promise<ScoredChunk[]> {
  if (candidateDocIds.length === 0) return []
  const perDocCap = options.perDocCap ?? SEARCH_PER_DOC_CAP
  const topK = options.topK ?? SEARCH_TOP_K
  const queryText = (options.queryText ?? '').trim()

  // Branch 1: cosine-only (legacy callers without raw query text).
  if (queryText.length === 0 || queryVec.length === 0) {
    if (queryVec.length === 0) return []
    const scored = isVecAvailable()
      ? await retrieveViaVec0(candidateDocIds, queryVec, {}, dek)
      : await retrieveViaJsCosine(candidateDocIds, queryVec, {}, dek)
    return applyPerDocCap(scored, perDocCap, topK)
  }

  // Branch 2: hybrid (vec + BM25, RRF-fused).
  const vecHits = isVecAvailable()
    ? await retrieveViaVec0(candidateDocIds, queryVec, { k: FIRST_STAGE_K, maxDistance: 1 }, dek)
    : await retrieveViaJsCosine(candidateDocIds, queryVec, { minScore: 0 }, dek)
  const ftsHits = await retrieveViaFts(candidateDocIds, queryText, { limit: FIRST_STAGE_K }, dek)

  // If FTS5 found nothing, treat as cosine-only with the normal threshold.
  if (ftsHits.length === 0) {
    const cosineOnly = vecHits.filter(h => h.score >= SEARCH_MIN_SCORE)
    return applyPerDocCap(cosineOnly, perDocCap, topK)
  }

  const fused = reciprocalRankFusion([vecHits, ftsHits])
  return applyPerDocCap(fused, perDocCap, topK)
}

function applyPerDocCap(
  scored: ScoredChunk[],
  perDocCap: number,
  topK: number,
): ScoredChunk[] {
  const out: ScoredChunk[] = []
  const perDoc = new Map<number, number>()
  for (const hit of scored) {
    if (out.length >= topK) break
    const used = perDoc.get(hit.docId) ?? 0
    if (used >= perDocCap) continue
    perDoc.set(hit.docId, used + 1)
    out.push(hit)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  High-level helper for MCP search_notes                                     */
/* -------------------------------------------------------------------------- */

/**
 * Embed the query, run hybrid retrieval, rerank, derive per-chunk highlight.
 * Used by `searchUserWorkspace` (MCP `search_notes`).
 *
 * Chat (`chat.post.ts`) does NOT call this — it embeds the query itself
 * because it interleaves with conversation rewriting + reranking, and its
 * post-stream highlight is computed against the model's answer rather than
 * the query.
 */
export async function searchWorkspaceChunks(
  candidateDocIds: number[],
  query: string,
  dek: Buffer | null = null,
): Promise<SearchHit[]> {
  if (candidateDocIds.length === 0) return []
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const [queryVec] = await mistralEmbed([trimmed])
  if (!queryVec || queryVec.length === 0) return []

  // Oversample first stage so the reranker has room to work.
  const RERANK_POOL = Math.max(SEARCH_TOP_K * 3, 15)
  const scored = await rankChunks(candidateDocIds, queryVec, {
    queryText: trimmed,
    topK: RERANK_POOL,
    perDocCap: Number.POSITIVE_INFINITY,
  }, dek)
  const reranked = await rerankChunks(trimmed, scored, SEARCH_TOP_K * 2)
  const capped = applyPerDocCap(reranked, SEARCH_PER_DOC_CAP, SEARCH_TOP_K)

  return capped.map((s): SearchHit => {
    const snippet = truncate(s.text, SEARCH_SNIPPET_MAX)
    return {
      docId: s.docId,
      idx: s.idx,
      snippet,
      highlight: bestSentence(snippet, trimmed),
      score: s.score,
    }
  })
}
