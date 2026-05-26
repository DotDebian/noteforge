import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'

/**
 * Restore a soft-deleted document: clear `deletedAt`.
 *
 * Note: if the document used to live inside a folder that has since been
 * trashed, we leave `folderId` as-is. The document will still belong to
 * that (trashed) folder but, because the folder is trashed, the document
 * will effectively float at the workspace root in active views — the tree
 * filter discards the trashed folder while the document is shown.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)

  if (doc.deletedAt == null) {
    throw createError({ statusCode: 400, statusMessage: 'Document is not trashed' })
  }

  const db = useDb()
  const [updated] = await db
    .update(documents)
    .set({ deletedAt: null })
    .where(eq(documents.id, id))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }
  return { document: updated }
})
