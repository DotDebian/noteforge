import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { softDeleteUserFolder } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

/**
 * Soft-delete a folder and its entire active subtree (folders + documents).
 * All rows in the cascade share the same `deletedAt` timestamp so the
 * restore endpoint can re-hydrate exactly the same group.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  return await softDeleteUserFolder(user.id, id)
})
