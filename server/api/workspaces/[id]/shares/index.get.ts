/**
 * List members of a shared workspace. Visible to any member — the share
 * dialog needs to render the list for viewers too so they know who else
 * has access. Owner-only operations (revoke / change role) are gated on
 * their own endpoints.
 */
import { defineEventHandler } from 'h3'
import { assertWorkspaceMembership, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'
import { listShareMembers } from '~/server/utils/workspace-share'

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  const user = await requireUser(event)
  await assertWorkspaceMembership(user.id, workspaceId)
  const members = await listShareMembers(workspaceId)
  return { members }
})
