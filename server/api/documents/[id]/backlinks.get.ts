import { and, eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { docLinks, documents } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { decryptField } from '~/server/utils/crypto'
import { getWorkspaceKey } from '~/server/utils/workspace-key'

/**
 * Sprint 4 / F2 — incoming wiki-style links to this document.
 *
 * Returns the (docId, title) of every active document whose body contains a
 * `/w/:workspaceId/d/:docId` link to the requested doc. Soft-deleted source
 * docs are excluded via `activeDocsWhere`.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const doc = await assertDocumentAccess(event, id)
  // Backlinks are intra-workspace (see extractDocLinks), so every source
  // doc's title is encrypted under this one workspace's key.
  const dek = await getWorkspaceKey(event, doc.workspaceId)

  const db = useDb()
  const rows = await db
    .select({
      docId: documents.id,
      title: documents.title,
    })
    .from(docLinks)
    .innerJoin(documents, eq(documents.id, docLinks.sourceDocId))
    .where(and(eq(docLinks.targetDocId, id), activeDocsWhere()))

  // De-dup in case of any rogue duplicate rows; preserve sort by title for
  // a stable UI. Titles are decrypted with the per-user DEK before sort.
  const seen = new Set<number>()
  const backlinks: { docId: number, title: string }[] = []
  for (const r of rows) {
    if (seen.has(r.docId)) continue
    seen.add(r.docId)
    backlinks.push({ docId: r.docId, title: decryptField(r.title, dek) })
  }
  backlinks.sort((a, b) => a.title.localeCompare(b.title))

  return { backlinks }
})
