import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, documentVersions } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { decryptDocument } from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'

/**
 * Restore a document to the contents of a previous version.
 *
 * Atomic in a single sync transaction:
 *   1. Insert a `pre_restore` snapshot of the current doc state — guarantees
 *      the user always has an undo path back to whatever was on screen
 *      immediately before they hit "Restore".
 *   2. Overwrite `documents.title`, `markdown`, `contentJson` with the
 *      target version's payload.
 *
 * If either step throws, the transaction rolls back and the doc is
 * unchanged.
 */
export default defineEventHandler(async (event) => {
  const docId = parseIdParam(event, 'id')
  const versionId = parseIdParam(event, 'versionId')
  const doc = await assertDocumentAccess(event, docId)
  const user = await requireUser(event)
  const dek = await getDek(event)

  const db = useDb()
  const [version] = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1)

  if (!version || version.docId !== docId) {
    throw createError({ statusCode: 404, statusMessage: 'Version not found' })
  }

  const updated = db.transaction((tx) => {
    tx.insert(documentVersions).values({
      docId: doc.id,
      markdown: doc.markdown,
      contentJson: doc.contentJson,
      title: doc.title,
      createdBy: user.id,
      reason: 'pre_restore',
    }).run()

    const rows = tx
      .update(documents)
      .set({
        title: version.title,
        markdown: version.markdown,
        contentJson: version.contentJson,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId))
      .returning()
      .all()

    return rows[0] ?? null
  })

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }

  return { document: decryptDocument(updated, dek) }
})
