import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { getUserWorkspace } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const dek = await getDek(event)
  return await getUserWorkspace(user.id, id, dek)
})
