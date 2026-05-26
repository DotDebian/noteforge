import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documentVersions } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'

/**
 * User-initiated checkpoint. Captures the doc's current title / markdown /
 * contentJson with reason `manual_snapshot` — these rows are exempt from
 * the lazy retention policy (future work) and persist until the doc is
 * permanently deleted.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)
  const user = await requireUser(event)
  const dek = await getDek(event)

  const db = useDb()
  const [version] = await db
    .insert(documentVersions)
    .values({
      docId: doc.id,
      markdown: doc.markdown,
      contentJson: doc.contentJson,
      title: doc.title,
      createdBy: user.id,
      reason: 'manual_snapshot',
    })
    .returning()

  return {
    version: {
      id: version!.id,
      title: decryptField(version!.title, dek),
      createdAt: version!.createdAt,
      reason: version!.reason,
    },
  }
})
