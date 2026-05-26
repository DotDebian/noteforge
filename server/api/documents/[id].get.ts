import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { getUserDocument } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

/**
 * REST single-doc fetch intentionally returns trashed documents
 * (`includeTrashed: true`) — the trash / restore UI needs them. MCP's
 * `read_document` passes `includeTrashed: false` to hide trashed rows from
 * external clients.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const dek = await getDek(event)
  return await getUserDocument(user.id, id, { includeTrashed: true }, dek)
})
