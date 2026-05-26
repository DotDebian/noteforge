import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documentVersions } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { decryptDocumentVersion } from '~/server/utils/encrypted-entities'

/**
 * Fetch a single document version, including its full markdown / contentJson
 * so the history modal can render a read-only preview of the snapshot.
 *
 * The version is gated by `assertDocumentAccess` on the parent doc, then by
 * an explicit docId-match check — without that, a user with access to doc A
 * could probe arbitrary version IDs belonging to doc B.
 */
export default defineEventHandler(async (event) => {
  const docId = parseIdParam(event, 'id')
  const versionId = parseIdParam(event, 'versionId')
  await assertDocumentAccess(event, docId)
  const dek = await getDek(event)

  const db = useDb()
  const [version] = await db
    .select({
      id: documentVersions.id,
      docId: documentVersions.docId,
      title: documentVersions.title,
      markdown: documentVersions.markdown,
      contentJson: documentVersions.contentJson,
      createdAt: documentVersions.createdAt,
      reason: documentVersions.reason,
    })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1)

  if (!version || version.docId !== docId) {
    throw createError({ statusCode: 404, statusMessage: 'Version not found' })
  }

  const decrypted = decryptDocumentVersion({
    title: version.title,
    markdown: version.markdown,
    contentJson: version.contentJson,
  }, dek)
  return {
    version: {
      id: version.id,
      title: decrypted.title ?? '',
      markdown: decrypted.markdown ?? '',
      contentJson: decrypted.contentJson ?? '{}',
      createdAt: version.createdAt,
      reason: version.reason,
    },
  }
})
