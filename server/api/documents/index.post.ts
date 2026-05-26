import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { getDek } from '~/server/utils/dek'
import { createUserDocument } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  workspaceId: z.number().int().positive(),
  folderId: z.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  position: z.number().int().min(0).optional(),
})

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  const dek = await getDek(event)
  const document = await createUserDocument(user.id, input, dek)
  return { document }
})
