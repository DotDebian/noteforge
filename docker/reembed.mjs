/**
 * Re-embed every stored chunk with the current embedding model.
 *
 * Vectors from different models live in different spaces, so after switching
 * the embedding provider/model (Mistral → Voyage) the stored vectors are
 * useless against freshly embedded queries until this has run.
 *
 * It needs no user key: chunk bodies are encrypted in `doc_chunks.text`, but
 * the FTS5 mirror (`doc_chunks_fts`, rowid = `doc_chunks.id`) holds the same
 * text in the clear, and that is what gets embedded.
 *
 * What it does:
 *  1. Backs the database up next to itself (`<db>.pre-reembed-<timestamp>`).
 *  2. Re-embeds each chunk and rewrites `doc_chunks.embedding`,
 *     `doc_chunks.embedding_blob` and its `doc_chunks_vec` row. A chunk with
 *     no FTS text has its vector cleared instead (it stays keyword-less and
 *     vector-less until its note is re-analysed).
 *  3. Clears `doc_analyses.summary_embedding`. Those are built from encrypted
 *     title + summary, so they can't be rebuilt here; related-notes falls back
 *     to chunk vectors until a note is re-analysed.
 *
 * Resumable: progress is kept in `<db dir>/.reembed-<model>.json`, so a rerun
 * after an interruption (or a rate limit) continues where it stopped, and a
 * rerun after completion is a no-op.
 *
 * Run inside the container:
 *   docker exec noteforge node /app/docker/reembed.mjs [--dry-run]
 * Or on a host copy:
 *   DATABASE_URL=path/to.db VOYAGE_API_KEY=… node docker/reembed.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const EMBED_DIM = 1024
const BATCH = 32
const MAX_ATTEMPTS = 8

const dryRun = process.argv.includes('--dry-run')
const dbPath = resolve(process.env.DATABASE_URL || '/app/data/noteforge.db')
const apiKey = process.env.VOYAGE_API_KEY
const model = process.env.VOYAGE_EMBED_MODEL || 'voyage-4-large'
const statePath = join(dirname(dbPath), `.reembed-${model}.json`)

if (!existsSync(dbPath)) {
  console.error(`[reembed] database not found: ${dbPath}`)
  process.exit(1)
}
if (!apiKey && !dryRun) {
  console.error('[reembed] VOYAGE_API_KEY is not set')
  process.exit(1)
}

const sqlite = new Database(dbPath, { readonly: dryRun })
sqlite.pragma('busy_timeout = 10000')
sqliteVec.load(sqlite)

/** Embed one batch, waiting out rate limits and transient errors. */
async function embed(texts) {
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts, input_type: 'document', output_dimension: EMBED_DIM }),
      })
    }
    catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
      await sleep(5000)
      continue
    }
    if (res.ok) {
      const json = await res.json()
      const out = new Array(texts.length)
      for (const item of json.data) out[item.index] = item.embedding
      if (out.some(v => !Array.isArray(v) || v.length !== EMBED_DIM)) {
        throw new Error(`unexpected embedding shape from ${model}`)
      }
      return { vectors: out, tokens: json.usage?.total_tokens ?? 0 }
    }
    const detail = (await res.text().catch(() => '')).trim()
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Voyage ${res.status}: ${detail}`)
    }
    // The free tier is rate-limited per minute; a short wait clears it.
    console.log(`[reembed] ${res.status} from Voyage, retrying in 25s (attempt ${attempt}/${MAX_ATTEMPTS})`)
    await sleep(25000)
  }
}

function floatsToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer)
}

const total = sqlite.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS maxId FROM doc_chunks').get()
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  // `untilId` pins the job to the chunks that existed when it first started:
  // anything written later was already embedded with the current model.
  : { model, untilId: total.maxId, lastId: 0, done: false }

const remaining = sqlite
  .prepare('SELECT COUNT(*) AS c FROM doc_chunks WHERE id > ? AND id <= ?')
  .get(state.lastId, state.untilId).c
console.log(`[reembed] ${dbPath}: ${total.c} chunk(s), ${remaining} left to re-embed with ${model}`)

if (state.done || dryRun) {
  console.log(state.done ? '[reembed] already completed — nothing to do' : '[reembed] dry run — no changes made')
  sqlite.close()
  process.exit(0)
}

if (state.lastId === 0) {
  const backupPath = `${dbPath}.pre-reembed-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await sqlite.backup(backupPath)
  console.log(`[reembed] backup written to ${backupPath}`)
}

const selectBatch = sqlite.prepare(
  `SELECT c.id AS id, f.text AS text
     FROM doc_chunks c LEFT JOIN doc_chunks_fts f ON f.rowid = c.id
    WHERE c.id > ? AND c.id <= ?
    ORDER BY c.id LIMIT ?`,
)
const updateChunk = sqlite.prepare('UPDATE doc_chunks SET embedding = ?, embedding_blob = ? WHERE id = ?')
const deleteVec = sqlite.prepare('DELETE FROM doc_chunks_vec WHERE chunk_id = ?')
const insertVec = sqlite.prepare('INSERT INTO doc_chunks_vec(chunk_id, embedding) VALUES (?, ?)')

// One transaction per batch, so an interruption never leaves a chunk whose
// blob and vec0 row disagree.
const writeBatch = sqlite.transaction((rows, vectors) => {
  let v = 0
  for (const r of rows) {
    // vec0 only accepts INTEGER-bound primary keys — hence the BigInt.
    deleteVec.run(BigInt(r.id))
    if (!r.text) {
      updateChunk.run(null, null, r.id)
      continue
    }
    const vec = vectors[v++]
    const blob = floatsToBuffer(vec)
    updateChunk.run(JSON.stringify(vec), blob, r.id)
    insertVec.run(BigInt(r.id), blob)
  }
})

let embedded = 0
let cleared = 0
let tokens = 0
for (;;) {
  const rows = selectBatch.all(state.lastId, state.untilId, BATCH)
  if (rows.length === 0) break
  const withText = rows.filter(r => r.text)
  const result = withText.length > 0 ? await embed(withText.map(r => r.text)) : { vectors: [], tokens: 0 }
  writeBatch(rows, result.vectors)
  embedded += withText.length
  cleared += rows.length - withText.length
  tokens += result.tokens
  state.lastId = rows[rows.length - 1].id
  writeFileSync(statePath, JSON.stringify(state))
  console.log(`[reembed] ${embedded + cleared}/${remaining} (${tokens} tokens)`)
}

const summaries = sqlite.prepare('UPDATE doc_analyses SET summary_embedding = NULL WHERE summary_embedding IS NOT NULL').run()
state.done = true
writeFileSync(statePath, JSON.stringify(state))

console.log(`[reembed] done: ${embedded} chunk(s) re-embedded, ${cleared} cleared (no text), ${summaries.changes} summary vector(s) reset, ${tokens} tokens used`)
sqlite.close()
