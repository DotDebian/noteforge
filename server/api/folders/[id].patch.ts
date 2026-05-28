import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { assertFolderMembership, parseIdParam } from '~/server/utils/access'
import { updateUserFolder } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

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
  const { workspace } = await assertFolderMembership(user.id, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const folder = await updateUserFolder(user.id, id, input, key)
  return { folder }
})
