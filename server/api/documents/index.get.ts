import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getDek } from '~/server/utils/dek'
import { listUserDocuments } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
  folderId: z
    .union([z.literal('root'), z.coerce.number().int().positive()])
    .optional(),
})

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, Query.parse)
  const user = await requireUser(event)
  const dek = await getDek(event)
  const documents = await listUserDocuments(user.id, q.workspaceId, {
    folderId: q.folderId,
  }, dek)
  return { documents }
})
