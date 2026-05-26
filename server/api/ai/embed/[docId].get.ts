/**
 * Embedding-status probe — used by the Insights panel to decide whether to
 * show a "Re-index" prompt. Returns chunk counts plus the freshest of:
 * - last successful embed (max(created_at) over doc_chunks)
 * - last embed failure recorded on doc_analyses (Sprint 6 / I*)
 */
import { eq, sql } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses, docChunks } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'

export default defineEventHandler(async (event) => {
  const docId = parseIdParam(event, 'docId')
  await assertDocumentAccess(event, docId)

  const db = useDb()

  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      lastAt: sql<number | null>`MAX(${docChunks.createdAt})`,
    })
    .from(docChunks)
    .where(eq(docChunks.docId, docId))

  const [analysis] = await db
    .select({
      embedError: docAnalyses.embedError,
      embedFailedAt: docAnalyses.embedFailedAt,
    })
    .from(docAnalyses)
    .where(eq(docAnalyses.docId, docId))
    .limit(1)

  const chunkCount = counts?.total ?? 0
  return {
    chunkCount,
    indexed: chunkCount > 0,
    lastIndexedAt: counts?.lastAt ?? null,
    error: analysis?.embedError ?? null,
    errorAt: analysis?.embedFailedAt ?? null,
  }
})
