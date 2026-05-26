/**
 * Vector utilities.
 *
 * Embeddings are stored as a Float32 little-endian BLOB in
 * `doc_chunks.embedding_blob` (preferred) with a legacy JSON-encoded
 * `number[]` fallback in `doc_chunks.embedding` for rows that haven't been
 * backfilled yet. The sqlite-vec extension is loaded opportunistically by the
 * DB client; for now we run cosine similarity in JS (a single workspace fits
 * comfortably in memory).
 *
 * Endianness note: Node's Buffer is host endian. On x86/ARM that's
 * little-endian, which matches sqlite-vec's expected layout. We don't support
 * big-endian platforms.
 */

/**
 * JS-side cosine similarity. As of Sprint 3 / I1, retrieval is done via
 * `sqlite-vec`'s vec0 MATCH operator (`distance_metric=cosine`) and this
 * helper is only exercised by:
 *   - the fallback path in `chat.post.ts` / `related/[docId].get.ts` when
 *     `sqlite-vec` failed to load (`isVecAvailable() === false`);
 *   - the unit tests in `tests/vector.test.ts`.
 * Hot retrieval no longer calls it.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  return dot / denom
}

export function serializeEmbedding(v: number[]): string {
  return JSON.stringify(v)
}

/**
 * Encode a vector as a Float32 Buffer. The returned Buffer owns its memory
 * (the underlying ArrayBuffer is freshly allocated by `new Float32Array(vec)`
 * — Node's `Buffer.from(arrayBuffer)` then wraps that buffer without copying,
 * but no other view shares it, so the bytes are effectively owned).
 */
export function floatsToBuffer(vec: number[]): Buffer {
  const arr = new Float32Array(vec)
  return Buffer.from(arr.buffer)
}

/**
 * Decode a Float32 Buffer back to a plain `number[]`. Returns `[]` for
 * null/empty input or buffers whose length isn't a multiple of 4 bytes.
 */
export function bufferToFloats(buf: Buffer | null | undefined): number[] {
  if (!buf || buf.byteLength === 0) return []
  if (buf.byteLength % 4 !== 0) return []
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const out: number[] = new Array(view.length)
  for (let i = 0; i < view.length; i++) out[i] = view[i] ?? 0
  return out
}

export function parseEmbedding(s: string | null | undefined): number[] {
  if (!s) return []
  try {
    const parsed = JSON.parse(s) as unknown
    if (!Array.isArray(parsed)) return []
    const out: number[] = []
    for (const x of parsed) {
      if (typeof x === 'number' && Number.isFinite(x)) out.push(x)
    }
    return out
  }
  catch {
    return []
  }
}

/**
 * Read an embedding from a row that has either the new BLOB column or the
 * legacy TEXT column (or both). BLOB wins when both are present so a
 * partially-backfilled DB stays correct.
 */
export function loadEmbedding(row: {
  embeddingBlob?: Buffer | null
  embedding?: string | null
}): number[] {
  if (row.embeddingBlob && row.embeddingBlob.byteLength > 0) {
    const v = bufferToFloats(row.embeddingBlob)
    if (v.length > 0) return v
  }
  return parseEmbedding(row.embedding)
}

/**
 * Mean of N same-length vectors. Returns [] if input is empty or shapes mismatch.
 */
export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const first = vectors[0]
  if (!first || first.length === 0) return []
  const dim = first.length
  const acc = new Array<number>(dim).fill(0)
  let count = 0
  for (const v of vectors) {
    if (v.length !== dim) continue
    for (let i = 0; i < dim; i++) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0)
    count++
  }
  if (count === 0) return []
  for (let i = 0; i < dim; i++) acc[i] = (acc[i] ?? 0) / count
  return acc
}
