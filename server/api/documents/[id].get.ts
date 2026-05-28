import { defineEventHandler } from 'h3'
import { assertDocumentMembership, parseIdParam } from '~/server/utils/access'
import { getUserDocument } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

/**
 * REST single-doc fetch intentionally returns trashed documents
 * (`includeTrashed: true`) — the trash / restore UI needs them. MCP's
 * `read_document` passes `includeTrashed: false` to hide trashed rows from
 * external clients.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const { workspace } = await assertDocumentMembership(user.id, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  return await getUserDocument(user.id, id, { includeTrashed: true }, key)
})
