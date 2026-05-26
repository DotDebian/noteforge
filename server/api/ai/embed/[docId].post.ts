import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'
import { applyRateLimit } from '~/server/utils/rate-limit'
import { embedDocument } from '~/server/utils/embed-doc'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  applyRateLimit(event, user.id, 'embed')
  const docId = parseIdParam(event, 'docId')
  const doc = await assertDocumentAccess(event, docId)

  if (doc.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: 'Document is in trash' })
  }
  if (!doc.markdown || doc.markdown.trim().length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Document is empty' })
  }

  const db = useDb()

  try {
    const count = await embedDocument(docId, doc.markdown)
    // Clear any prior failure record so the UI badge flips back to "indexed".
    // `doc_analyses` row may not exist if the user never ran analysis — the
    // update simply affects zero rows in that case.
    await db
      .update(docAnalyses)
      .set({ embedError: null, embedFailedAt: null })
      .where(eq(docAnalyses.docId, docId))
    return { chunks: count }
  }
  catch (err) {
    const e = err as { data?: { detail?: string }, statusMessage?: string, message?: string }
    const detail = e?.data?.detail ?? e?.statusMessage ?? e?.message ?? 'unknown error'
    try {
      await db
        .update(docAnalyses)
        .set({ embedError: detail.slice(0, 1000), embedFailedAt: new Date() })
        .where(eq(docAnalyses.docId, docId))
    }
    catch (writeErr) {
      console.error('[ai/embed] failed to record embed error', writeErr)
    }
    throw err
  }
})
