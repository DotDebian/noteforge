import { desc, eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documentVersions } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'

/**
 * List versions for a document, newest first.
 *
 * Projection intentionally omits `markdown` / `contentJson` — those are
 * loaded on demand by the per-version GET when the user previews a row.
 * Keeps the timeline payload cheap even for docs with hundreds of
 * autosave snapshots.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  await assertDocumentAccess(event, id)
  const dek = await getDek(event)

  const db = useDb()
  const versions = await db
    .select({
      id: documentVersions.id,
      title: documentVersions.title,
      createdAt: documentVersions.createdAt,
      reason: documentVersions.reason,
    })
    .from(documentVersions)
    .where(eq(documentVersions.docId, id))
    .orderBy(desc(documentVersions.createdAt))

  return {
    versions: versions.map(v => ({ ...v, title: decryptField(v.title, dek) })),
  }
})
