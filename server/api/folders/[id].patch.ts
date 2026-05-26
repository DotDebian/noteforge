import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { updateUserFolder } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

const Body = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    parentId: z.number().int().positive().nullable().optional(),
    position: z.number().int().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.parentId !== undefined || v.position !== undefined,
    { message: 'No fields to update' },
  )

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  const dek = await getDek(event)
  const folder = await updateUserFolder(user.id, id, input, dek)
  return { folder }
})
