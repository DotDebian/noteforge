/**
 * Second-stage LLM reranker.
 *
 * After the first-stage retrieval (vec0 cosine + FTS5 BM25, fused via RRF),
 * we feed the top-N candidates to Claude and ask it to score each one against
 * the query in [0, 10]. The model sees the snippets in isolation — no
 * chunk-id, no doc title, no metadata — so its judgment is purely "does this
 * snippet help answer this query".
 *
 * The scores come back as a JSON line in a plain single-turn reply rather
 * than through schema-validated structured output: that path costs an extra
 * turn, and this call sits in front of the chat's first token. A reply we
 * can't parse is just a failure, which is soft here.
 *
 * Failure-soft: any error returns the input candidates unchanged so chat
 * never blocks on the reranker.
 */
import { claudeChat } from './claude'
import type { ScoredChunk } from './search'
import { createCircuitBreaker } from './circuit-breaker'

/**
 * Breaker for the LLM reranker call. After 3 failures within 60s the breaker
 * opens for 60s, during which `rerankChunks` short-circuits and returns the
 * first-stage pool unchanged. Protects chat latency when Claude is degraded.
 */
const rerankerBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 })

/** Read-only accessor so future admin panels can surface breaker state. */
export function getRerankerCircuitOpen(): boolean {
  return rerankerBreaker.isOpen()
}

/** Cap for the per-candidate snippet shown to the reranker. */
const RERANK_SNIPPET_MAX = 600

/** How much the LLM score (0..1) outweighs the prior retrieval score. */
const LLM_WEIGHT = 0.7
const PRIOR_WEIGHT = 1 - LLM_WEIGHT

const SYSTEM_PROMPT = `You rerank search snippets from a user's personal notes. Your scores decide which snippets are handed to the assistant that answers the user's question, so a high score should mean "this snippet helps answer the query".

For each numbered snippet, judge how relevant it is to the QUERY on a 0-to-10 integer scale:
  10 = directly contains the answer
   7 = closely related and likely useful
   4 = tangentially related
   0 = unrelated

Be strict: most snippets are noise. Score each snippet independently of the others and of their order.

Your reply is parsed by a program. Output only this JSON object, with one entry per snippet and no code fence or commentary:
{"scores":[{"i":<snippet index>,"s":<score 0-10>}, ...]}`

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
  // Breaker open → skip the LLM call entirely and pass the pool through.
  if (rerankerBreaker.isOpen()) return candidates.slice(0, topK)

  const numbered = candidates
    .map((c, i) => `[${i}] ${truncate(c.text, RERANK_SNIPPET_MAX)}`)
    .join('\n\n')

  const userPrompt = `QUERY:\n${q}\n\nSNIPPETS:\n${numbered}`

  let llmScores: number[]
  try {
    const { content } = await claudeChat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      userId,
      operation: 'rerank',
    })
    // Parse the outermost object so a stray code fence doesn't sink the call.
    const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)
    const parsed = JSON.parse(json) as RerankResponse
    llmScores = parseScores(parsed, candidates.length)
    rerankerBreaker.recordSuccess()
  }
  catch {
    rerankerBreaker.recordFailure()
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
