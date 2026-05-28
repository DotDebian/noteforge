import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { getUserWorkspace } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKey } from '~/server/utils/workspace-key'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const key = await getWorkspaceKey(event, id)
  return await getUserWorkspace(user.id, id, key)
})
