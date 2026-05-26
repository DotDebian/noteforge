import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'

/**
 * Permanently delete a document. Requires the document to be in the
 * trash already (soft-deleted). `doc_analyses` / `doc_chunks` are wiped
 * via the existing ON DELETE CASCADE foreign keys.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)

  if (doc.deletedAt == null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Document must be in trash before permanent deletion',
    })
  }

  const db = useDb()
  await db.delete(documents).where(eq(documents.id, id))
  return { ok: true }
})
