import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentMembership, parseIdParam } from '~/server/utils/access'
import { decryptDocument } from '~/server/utils/encrypted-entities'
import { slugify } from '~/server/utils/export'
import { renderDocPdf } from '~/server/utils/export-pdf'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const { document, workspace } = await assertDocumentMembership(user.id, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const doc = decryptDocument(document, key)

  const buf = await renderDocPdf(doc)
  const filename = `${slugify(doc.title || 'untitled')}.pdf`

  setHeader(event, 'Content-Type', 'application/pdf')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', buf.byteLength)
  return buf
})
