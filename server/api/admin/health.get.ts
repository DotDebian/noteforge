import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = getRawDb()

  const tables = [
    'users', 'workspaces', 'documents', 'folders',
    'doc_chunks', 'doc_analyses', 'chat_sessions', 'chat_messages',
    'ai_usage_logs', 'mcp_tokens', 'favorites', 'doc_links',
    'attachments', 'share_tokens', 'document_versions',
  ]
  const tableCounts = tables.map((t) => {
    const row = db.prepare(`SELECT count(*) AS cnt FROM ${t}`).get() as { cnt: number }
    return { table: t, count: row.cnt }
  })

  const lastEmbedRow = db.prepare(
    `SELECT max(created_at) AS ts FROM doc_chunks`,
  ).get() as { ts: number | null }

  const unindexedRow = db.prepare(
    `SELECT count(*) AS cnt FROM documents
     WHERE deleted_at IS NULL
       AND id NOT IN (SELECT DISTINCT doc_id FROM doc_chunks)`,
  ).get() as { cnt: number }

  let dbFileSizeBytes = 0
  try {
    const dbPath = resolve(process.cwd(), process.env.DATABASE_URL ?? 'data/noteforge.db')
    dbFileSizeBytes = statSync(dbPath).size
  }
  catch { /* path may differ in some envs */ }

  /* ---------- MCP tokens breakdown ----------------------------------------- */
  const mcpActive = (db.prepare(
    'SELECT count(*) AS cnt FROM mcp_tokens WHERE revoked_at IS NULL',
  ).get() as { cnt: number }).cnt
  const mcpRevoked = (db.prepare(
    'SELECT count(*) AS cnt FROM mcp_tokens WHERE revoked_at IS NOT NULL',
  ).get() as { cnt: number }).cnt
  const mcpNeverUsed = (db.prepare(
    'SELECT count(*) AS cnt FROM mcp_tokens WHERE last_used_at IS NULL AND revoked_at IS NULL',
  ).get() as { cnt: number }).cnt
  const mcpTotal = mcpActive + mcpRevoked

  /* ---------- Index drift (doc_chunks vs FTS5 vs vec0) --------------------- */
  const docChunksCnt = (db.prepare('SELECT count(*) AS cnt FROM doc_chunks').get() as { cnt: number }).cnt

  let ftsCnt = 0
  try {
    ftsCnt = (db.prepare('SELECT count(*) AS cnt FROM doc_chunks_fts').get() as { cnt: number }).cnt
  }
  catch { /* table missing — leave at 0 (treated as drift) */ }

  let vecCnt: number | null = null
  try {
    vecCnt = (db.prepare('SELECT count(*) AS cnt FROM doc_chunks_vec').get() as { cnt: number }).cnt
  }
  catch { /* vec extension unavailable in this env */ }

  const hasDrift
    = docChunksCnt !== ftsCnt
    || (vecCnt !== null && vecCnt !== docChunksCnt)

  /* ---------- Trash size --------------------------------------------------- */
  const trashDocs = (db.prepare(
    'SELECT count(*) AS cnt FROM documents WHERE deleted_at IS NOT NULL',
  ).get() as { cnt: number }).cnt
  const trashFolders = (db.prepare(
    'SELECT count(*) AS cnt FROM folders WHERE deleted_at IS NOT NULL',
  ).get() as { cnt: number }).cnt
  const trashBytesRow = db.prepare(
    'SELECT COALESCE(SUM(LENGTH(markdown)), 0) AS bytes FROM documents WHERE deleted_at IS NOT NULL',
  ).get() as { bytes: number }
  const trashMarkdownBytes = trashBytesRow.bytes ?? 0

  /* ---------- DB growth — last 30 snapshots -------------------------------- */
  const snapshotRows = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, db_size_bytes AS sizeBytes, created_at AS ts
       FROM health_snapshots
      WHERE created_at >= unixepoch('now', '-30 days')
      ORDER BY created_at ASC`,
  ).all() as Array<{ day: string, sizeBytes: number, ts: number }>

  const snapshots = snapshotRows.map(r => ({ day: r.day, sizeBytes: r.sizeBytes }))
  const currentBytes = snapshots.length > 0
    ? snapshots[snapshots.length - 1]!.sizeBytes
    : dbFileSizeBytes

  // delta vs 7 days ago — closest snapshot at-or-before the cutoff
  let delta7d = 0
  let deltaPct7d = 0
  if (snapshots.length > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    const baseline = [...snapshotRows].reverse().find(r => r.ts <= cutoff)
      ?? snapshotRows[0]!
    delta7d = currentBytes - baseline.sizeBytes
    deltaPct7d = baseline.sizeBytes > 0
      ? (delta7d / baseline.sizeBytes) * 100
      : 0
  }

  return {
    dbFileSizeBytes,
    tableCounts,
    lastEmbedAt: lastEmbedRow.ts ? new Date(lastEmbedRow.ts * 1000).toISOString() : null,
    unindexedDocCount: unindexedRow.cnt,
    mcpTokens: {
      active: mcpActive,
      revoked: mcpRevoked,
      neverUsed: mcpNeverUsed,
      total: mcpTotal,
    },
    indexDrift: {
      docChunks: docChunksCnt,
      fts: ftsCnt,
      vec: vecCnt,
      hasDrift,
    },
    trash: {
      docs: trashDocs,
      folders: trashFolders,
      markdownBytes: trashMarkdownBytes,
    },
    dbGrowth: {
      snapshots,
      currentBytes,
      delta7d,
      deltaPct7d,
    },
  }
})
