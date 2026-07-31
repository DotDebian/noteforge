/**
 * Chunk a document's markdown, embed the chunks via Mistral, replace any
 * previously-stored chunks for that doc. Shared between the analyze endpoint
 * (which kicks it off in the background after analysis) and the explicit
 * /api/ai/embed/[docId] endpoint.
 *
 * Sprint 3 / I1: every chunk write is mirrored to the `doc_chunks_vec` vec0
 * virtual table so retrieval can use sqlite-vec's `MATCH` operator. The two
 * tables stay consistent: doc_chunks is wiped via Drizzle, then a single
 * better-sqlite3 transaction wipes the matching vec0 rows and inserts the
 * new (chunk_id, embedding) pairs alongside the doc_chunks INSERT ... RETURNING.
 * If the vec0 extension is unavailable the doc_chunks_vec statements are
 * skipped — JS-cosine fallback in `chat.post.ts` / `related/[docId].get.ts`
 * still works against `embedding_blob`.
 */
import { eq, sql } from 'drizzle-orm'
import { getRawDb, isVecAvailable, useDb } from '~/server/database/client'
import { docChunks } from '~/server/database/schema'
import { stripEmbeddedDataUrls } from '~/utils/excalidraw-scene'
import { chunkMarkdown } from './chunking'
import { encryptChunkText } from './encrypted-entities'
import { mistralEmbed } from './mistral'
import { floatsToBuffer, serializeEmbedding } from './vector'

const BATCH = 32

/** Mistral `mistral-embed` always returns 1024-dim vectors. */
export const EMBED_DIM = 1024

/**
 * Chunks stored on `doc_chunks.text` are encrypted at rest when a DEK is
 * supplied. The FTS5 mirror (`doc_chunks_fts`) still gets PLAINTEXT — BM25
 * needs cleartext tokens to be useful. That's a deliberate trade-off
 * documented in CLAUDE.md / crypto.ts: an attacker with raw DB access can
 * read FTS5 tokens (topical leak) but cannot reconstruct full chunk bodies.
 */

interface ChunkInsertRow {
  docId: number
  idx: number
  /** Already-encrypted ciphertext (or plaintext if no DEK). */
  text: string
  /** Plaintext, used for the FTS5 mirror — never persisted as a chunk text. */
  ftsText: string
  embedding: string
  embeddingBlob: Buffer
  sectionPath: string | null
}

export async function embedDocument(
  docId: number,
  markdown: string,
  dek: Buffer | null = null,
  userId?: number,
): Promise<number> {
  const db = useDb()
  // Drawings (and legacy in-note whiteboards) carry a PNG data URL in their
  // markdown. Embedding base64 wastes a Mistral call on noise and floods the
  // FTS5 mirror with meaningless tokens that then win BM25 matches — strip the
  // payloads and keep only what a human could read.
  const chunks = chunkMarkdown(stripEmbeddedDataUrls(markdown))

  /* ----- 1. Snapshot the chunk_ids we're about to remove ------------------ */
  // We need them so we can scrub the matching vec0 + FTS5 rows. Doing this
  // BEFORE the doc_chunks DELETE so the ids are still resolvable.
  const prior = await db
    .select({ id: docChunks.id })
    .from(docChunks)
    .where(eq(docChunks.docId, docId))
  const priorChunkIds = prior.map(r => r.id)

  /* ----- 2. Wipe existing chunks ----------------------------------------- */
  await db.delete(docChunks).where(eq(docChunks.docId, docId))
  if (priorChunkIds.length > 0) {
    const idList = sql.join(priorChunkIds.map(id => sql`${id}`), sql`, `)
    if (isVecAvailable()) {
      // vec0 isn't in the Drizzle schema — raw SQL.
      db.run(sql`DELETE FROM doc_chunks_vec WHERE chunk_id IN (${idList})`)
    }
    // FTS5 mirror: shared SQLite primary key (rowid) with doc_chunks.id.
    db.run(sql`DELETE FROM doc_chunks_fts WHERE rowid IN (${idList})`)
  }

  if (chunks.length === 0) return 0

  /* ----- 3. Embed -------------------------------------------------------- */
  const chunkTexts = chunks.map(c => c.text)
  const embeddings: number[][] = []
  for (let i = 0; i < chunkTexts.length; i += BATCH) {
    const vecs = await mistralEmbed(chunkTexts.slice(i, i + BATCH), { userId, operation: 'embed' })
    for (const v of vecs) embeddings.push(v)
  }

  // Sanity check on the first vector: if Mistral silently changes embedding
  // model dim we'd be writing rows of the wrong size and vec0 MATCH would
  // explode at query time. Fail loudly here instead.
  const firstVec = embeddings[0]
  if (firstVec && firstVec.length > 0 && firstVec.length !== EMBED_DIM) {
    throw new Error(
      `embed-doc: expected ${EMBED_DIM}-dim vectors, got ${firstVec.length}. ` +
      `If you changed the embed model, update EMBED_DIM and the vec0 schema.`,
    )
  }

  /* ----- 4. Build rows --------------------------------------------------- */
  // Transition: write both the legacy TEXT JSON column and the new BLOB
  // column. The TEXT column will be dropped in a follow-up migration once
  // all read paths consume the BLOB.
  const rows: ChunkInsertRow[] = chunks.map((chunk, idx) => {
    const vec = embeddings[idx] ?? []
    return {
      docId,
      idx,
      // doc_chunks.text stores ciphertext (or plaintext when no DEK).
      text: encryptChunkText(chunk.text, dek),
      // FTS5 mirror always gets plaintext — see top-of-file comment.
      ftsText: chunk.text,
      embedding: serializeEmbedding(vec),
      embeddingBlob: floatsToBuffer(vec),
      sectionPath: JSON.stringify(chunk.sectionPath),
    }
  })

  /* ----- 5. Insert atomically (doc_chunks + doc_chunks_vec) -------------- */
  writeChunksAtomic(rows)

  return rows.length
}

function writeChunksAtomic(rows: ChunkInsertRow[]): void {
  const sqlite = getRawDb()
  const vec = isVecAvailable()

  const insertChunk = sqlite.prepare<[number, number, string, string, Buffer, string | null], { id: number }>(
    `INSERT INTO doc_chunks (doc_id, idx, text, embedding, embedding_blob, section_path)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id AS id`,
  )

  // vec0 statement is only prepared if the extension is loaded — preparing a
  // statement that references doc_chunks_vec would throw if the virtual
  // table doesn't exist.
  const insertVec = vec
    ? sqlite.prepare<[number | bigint, Buffer]>(
        `INSERT INTO doc_chunks_vec(chunk_id, embedding) VALUES (?, ?)`,
      )
    : null

  // FTS5 mirror — keyed by the same rowid as doc_chunks.id. FTS5 is a core
  // SQLite module (no extension to load), so this statement is always safe.
  const insertFts = sqlite.prepare<[number | bigint, string]>(
    `INSERT INTO doc_chunks_fts(rowid, text) VALUES (?, ?)`,
  )

  // vec0's `embedding float[1024]` rejects buffers that aren't exactly that
  // many bytes — happens when Mistral occasionally returns fewer items than
  // requested and `mistralEmbed`'s backstop fills the slot with []. Skip
  // those rows from the vec table; JS-cosine fallback still works because
  // `embedding_blob` will be empty and `loadEmbedding` returns [].
  const expectedVecBytes = EMBED_DIM * 4

  const tx = sqlite.transaction((batch: ChunkInsertRow[]) => {
    for (const r of batch) {
      const inserted = insertChunk.get(r.docId, r.idx, r.text, r.embedding, r.embeddingBlob, r.sectionPath)
      if (!inserted) continue
      const idRaw = inserted.id
      const idNum = Number(idRaw as unknown as number | bigint)
      if (!Number.isFinite(idNum) || !Number.isInteger(idNum)) continue
      // FTS5 always gets PLAINTEXT (`ftsText`), even when `r.text` was
      // encrypted before write — BM25 over ciphertext is useless.
      insertFts.run(BigInt(idNum), r.ftsText)
      if (!insertVec) continue
      if (r.embeddingBlob.byteLength !== expectedVecBytes) continue
      // vec0 strictly validates SQLITE_INTEGER for PK bindings. better-sqlite3
      // binds JS `number` via sqlite3_bind_double (REAL) — even for whole
      // values — so vec0 rejects with "Only integers are allowed for primary
      // key values". Force INTEGER binding by passing a BigInt, which routes
      // through sqlite3_bind_int64.
      insertVec.run(BigInt(idNum), r.embeddingBlob)
    }
  })

  tx(rows)
}
