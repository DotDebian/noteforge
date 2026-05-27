/**
 * Second-stage Mistral reranker.
 *
 * After the first-stage retrieval (vec0 cosine + FTS5 BM25, fused via RRF),
 * we feed the top-N candidates to a small Mistral model and ask it to score
 * each one against the query in [0, 10]. The model sees the snippets in
 * isolation — no chunk-id, no doc title, no metadata — so its judgment is
 * purely "does this snippet help answer this query".
 *
 * Why a JSON-mode call rather than a bi-encoder reranker: we already depend
 * on Mistral and have no extra-process inference budget. A single
 * mistral-small JSON call (~3-8k tokens in) is cheap compared to the
 * generation we're about to do anyway.
 *
 * Failure-soft: any error returns the input candidates unchanged so chat
 * never blocks on the reranker.
 */
import { mistralChat } from './mistral'
import { FAST_MODEL } from './query-rewrite'
import type { ScoredChunk } from './search'

/** Cap for the per-candidate snippet shown to the reranker. */
const RERANK_SNIPPET_MAX = 600

/** How much the LLM score (0..1) outweighs the prior retrieval score. */
const LLM_WEIGHT = 0.7
const PRIOR_WEIGHT = 1 - LLM_WEIGHT

const SYSTEM_PROMPT = `You are a precision reranker for note-search snippets.

For each numbered snippet, judge how relevant it is to the user's QUERY on a
0-to-10 integer scale where:
  10 = directly contains the answer
   7 = closely related and likely useful
   4 = tangentially related
   0 = unrelated

Be strict — most snippets are noise. Score independently; ignore order. Reply
as JSON: {"scores":[{"i":<int index>,"s":<int 0-10>}, ...]} with one entry per
snippet. No prose, no commentary.`

interface RerankResponse {
  scores?: Array<{ i?: unknown, s?: unknown }>
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= n) return cleaned
  return `${cleaned.slice(0, n - 1).trimEnd()}…`
}

/**
 * Rerank a candidate list against the natural-language query. Returns a new
 * array sorted by combined score, truncated to `topK`. The original `score`
 * field on each ScoredChunk is replaced with the combined score so downstream
 * code (per-doc cap, MIN_SCORE checks) still works.
 *
 * `candidates` should already be filtered/capped by the first stage — passing
 * hundreds of candidates here is wasteful and would blow the prompt budget.
 */
export async function rerankChunks(
  query: string,
  candidates: ScoredChunk[],
  topK: number,
  userId?: number,
): Promise<ScoredChunk[]> {
  if (candidates.length === 0) return candidates
  if (candidates.length === 1) return candidates.slice(0, topK)
  const q = query.trim()
  if (q.length === 0) return candidates.slice(0, topK)

  const numbered = candidates
    .map((c, i) => `[${i}] ${truncate(c.text, RERANK_SNIPPET_MAX)}`)
    .join('\n\n')

  const userPrompt = `QUERY:\n${q}\n\nSNIPPETS:\n${numbered}`

  let llmScores: number[]
  try {
    const { content } = await mistralChat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0,
      model: FAST_MODEL,
      userId,
      operation: 'rerank',
    })
    const parsed = JSON.parse(content) as RerankResponse
    llmScores = parseScores(parsed, candidates.length)
  }
  catch {
    return candidates.slice(0, topK)
  }

  // Combine: convert LLM 0..10 to 0..1, weighted-sum with the prior score.
  const combined = candidates.map((c, i): ScoredChunk => {
    const llm = (llmScores[i] ?? 0) / 10
    const prior = clamp01(c.score)
    return {
      docId: c.docId,
      idx: c.idx,
      text: c.text,
      score: LLM_WEIGHT * llm + PRIOR_WEIGHT * prior,
    }
  })

  combined.sort((a, b) => b.score - a.score)
  return combined.slice(0, topK)
}

function parseScores(parsed: RerankResponse, expectedLen: number): number[] {
  const out = new Array<number>(expectedLen).fill(0)
  if (!parsed.scores || !Array.isArray(parsed.scores)) return out
  for (const entry of parsed.scores) {
    const i = typeof entry?.i === 'number' ? entry.i : -1
    const s = typeof entry?.s === 'number' ? entry.s : -1
    if (i < 0 || i >= expectedLen) continue
    if (s < 0) continue
    out[i] = Math.min(10, s)
  }
  return out
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
