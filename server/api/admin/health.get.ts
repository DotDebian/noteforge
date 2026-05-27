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

  return {
    dbFileSizeBytes,
    tableCounts,
    lastEmbedAt: lastEmbedRow.ts ? new Date(lastEmbedRow.ts * 1000).toISOString() : null,
    unindexedDocCount: unindexedRow.cnt,
  }
})
