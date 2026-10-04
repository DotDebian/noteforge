/**
 * Text embeddings through the Voyage AI REST API (raw fetch, no SDK).
 *
 *  - POST https://api.voyageai.com/v1/embeddings
 *
 * Voyage embeds queries and documents differently (`input_type`), so every
 * caller says which side it is on: `'document'` when indexing note content,
 * `'query'` when embedding a search / chat question.
 *
 * ⚠️ Vectors from different models are not comparable. Changing the model
 * means re-embedding every stored chunk — see `docker/reembed.mjs`.
 */
import { createError } from 'h3'
import { recordProviderSuccess } from './provider-health'
import { logAiUsage } from './ai-usage'

// `useRuntimeConfig` is an auto-imported Nitro helper in server contexts.

const VOYAGE_API_BASE = 'https://api.voyageai.com/v1'

/**
 * Dimension of every stored vector. `doc_chunks_vec` is declared
 * `float[1024]`, so this is requested explicitly rather than left to the
 * model's default.
 */
export const EMBED_DIM = 1024

/** How long, and how many times, indexing waits when Voyage answers 429. */
const RATE_LIMIT_WAIT_MS = 21_000
const RATE_LIMIT_RETRIES = 3

export type EmbedInputType = 'query' | 'document'

export interface EmbedOptions {
  inputType: EmbedInputType
  userId?: number
  operation?: string
}

interface VoyageEmbeddingResponse {
  data: Array<{ index: number, embedding: number[] }>
  model: string
  usage?: { total_tokens: number }
}

export function getEmbedModel(): string {
  return (useRuntimeConfig().voyageEmbedModel as string) || 'voyage-4-large'
}

function fail(detail: string): never {
  throw createError({
    statusCode: 502,
    statusMessage: 'embed_failed',
    data: { error: 'embed_failed', detail },
  })
}

export async function embedTexts(inputs: string[], opts: EmbedOptions): Promise<number[][]> {
  if (inputs.length === 0) return []
  const model = getEmbedModel()
  const operation = opts.operation ?? 'embed'
  const apiKey = useRuntimeConfig().voyageApiKey
  if (!apiKey || typeof apiKey !== 'string') fail('VOYAGE_API_KEY is not configured')

  const start = Date.now()
  const request = (): Promise<Response> => fetch(`${VOYAGE_API_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: inputs,
      input_type: opts.inputType,
      output_dimension: EMBED_DIM,
    }),
  })

  let res: Response
  try {
    res = await request()
    // Indexing runs in the background, so it can afford to wait out a
    // per-minute rate limit rather than leave a note without vectors. Queries
    // sit in front of a user and fall back to keyword search instead.
    for (let retry = 0; res.status === 429 && opts.inputType === 'document' && retry < RATE_LIMIT_RETRIES; retry++) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WAIT_MS))
      res = await request()
    }
  }
  catch (err) {
    logAiUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, 'network')
    fail((err as Error).message ?? 'network error')
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`)
    logAiUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, `http_${res.status}`)
    fail(detail)
  }

  const json = (await res.json()) as VoyageEmbeddingResponse
  // Re-order by index just in case the API doesn't guarantee order.
  const out: number[][] = new Array(inputs.length)
  for (const item of json.data) {
    if (item.index >= 0 && item.index < inputs.length) {
      out[item.index] = item.embedding
    }
  }
  // Fill any missing slots (shouldn't happen) with empty arrays so the caller
  // still gets a well-shaped result; downstream code can detect via length.
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out[i] = []
  }
  try { recordProviderSuccess('voyage') } catch { /* health tracking must never throw */ }
  const tokens = json.usage?.total_tokens ?? 0
  logAiUsage(opts.userId, model, operation, tokens, 0, tokens, true, Date.now() - start)
  return out
}

/**
 * Failure-soft `embedTexts`: an empty vector per input when the call fails
 * (no key, rate limit, outage) instead of a throw. Indexing and retrieval use
 * this so they degrade to keyword search (FTS5 BM25) rather than break — an
 * empty vector is the "no embedding" value both already understand.
 */
export async function embedTextsSoft(inputs: string[], opts: EmbedOptions): Promise<number[][]> {
  try {
    return await embedTexts(inputs, opts)
  }
  catch (err) {
    const detail = (err as { data?: { detail?: string } }).data?.detail ?? (err as Error).message
    console.warn(`[embeddings] unavailable, continuing without vectors: ${String(detail).trim()}`)
    return inputs.map(() => [])
  }
}
