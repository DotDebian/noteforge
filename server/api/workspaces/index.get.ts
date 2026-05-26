import { defineEventHandler } from 'h3'
import { getDek } from '~/server/utils/dek'
import { listUserWorkspaces } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const workspaces = await listUserWorkspaces(user.id, dek)
  return { workspaces }
})
