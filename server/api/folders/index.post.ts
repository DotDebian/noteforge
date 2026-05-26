import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { getDek } from '~/server/utils/dek'
import { createUserFolder } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  workspaceId: z.number().int().positive(),
  parentId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  position: z.number().int().min(0).optional(),
})

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  const dek = await getDek(event)
  const folder = await createUserFolder(user.id, input, dek)
  return { folder }
})
