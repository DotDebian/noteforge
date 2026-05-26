/**
 * Backfill `doc_chunks.embedding_blob` from the legacy JSON `embedding`
 * column. Idempotent (skips rows that already have a BLOB) and resumable
 * (batched).
 *
 * Run with: `pnpm db:backfill:embeddings`
 */
import { getRawDb } from './client'
import { floatsToBuffer, parseEmbedding } from '../utils/vector'

const BATCH_SIZE = 200

interface Row {
  id: number
  embedding: string | null
}

function main(): void {
  const sqlite = getRawDb()

  const countStmt = sqlite.prepare<[], { c: number }>(
    'SELECT COUNT(*) AS c FROM doc_chunks WHERE embedding_blob IS NULL AND embedding IS NOT NULL',
  )
  const countRow = countStmt.get()
  const remaining = countRow?.c ?? 0
  console.log(`[backfill] ${remaining} chunk(s) need an embedding_blob backfill`)
  if (remaining === 0) {
    console.log('[backfill] nothing to do')
    return
  }

  const selectStmt = sqlite.prepare<[number], Row>(
    'SELECT id, embedding FROM doc_chunks WHERE embedding_blob IS NULL AND embedding IS NOT NULL ORDER BY id LIMIT ?',
  )
  const updateStmt = sqlite.prepare<[Buffer, number]>(
    'UPDATE doc_chunks SET embedding_blob = ? WHERE id = ?',
  )

  let processed = 0
  let skipped = 0
  let batchNo = 0

  // Each iteration: fetch up to BATCH_SIZE rows that still need a backfill.
  // Because the UPDATE removes them from the predicate, we don't need an
  // offset — the next pass naturally surfaces the next slice.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = selectStmt.all(BATCH_SIZE)
    if (rows.length === 0) break
    batchNo++

    const tx = sqlite.transaction((batch: Row[]) => {
      for (const r of batch) {
        const vec = parseEmbedding(r.embedding)
        if (vec.length === 0) {
          skipped++
          continue
        }
        updateStmt.run(floatsToBuffer(vec), r.id)
        processed++
      }
    })
    tx(rows)

    console.log(`[backfill] batch ${batchNo}: processed=${processed} skipped=${skipped}`)
  }

  console.log(`[backfill] done: processed=${processed} skipped=${skipped}`)
}

try {
  main()
  process.exit(0)
}
catch (err) {
  console.error('[backfill] failed:', err)
  process.exit(1)
}
