import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentMembership, parseIdParam } from '~/server/utils/access'
import { decryptDocument } from '~/server/utils/encrypted-entities'
import { buildHtml, slugify } from '~/server/utils/export'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const { document, workspace } = await assertDocumentMembership(user.id, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const doc = decryptDocument(document, key)

  const body = buildHtml(doc)
  const filename = `${slugify(doc.title || 'untitled')}.html`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  return body
})
