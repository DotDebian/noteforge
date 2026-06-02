import { defineEventHandler, setHeader } from 'h3'
import { assertDocumentMembership, parseIdParam } from '~/server/utils/access'
import { decryptDocument } from '~/server/utils/encrypted-entities'
import { buildMarkdown, slugify } from '~/server/utils/export'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const { document, workspace } = await assertDocumentMembership(user.id, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const doc = decryptDocument(document, key)

  const body = buildMarkdown(doc)
  const filename = `${slugify(doc.title || 'untitled')}.md`

  setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  return body
})
