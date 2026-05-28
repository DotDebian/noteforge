import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { assertDocumentMembership, parseIdParam } from '~/server/utils/access'
import { updateUserDocument } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

const Body = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    markdown: z.string().max(2_000_000).optional(),
    contentJson: z.string().max(4_000_000).optional(),
    folderId: z.number().int().positive().nullable().optional(),
    position: z.number().int().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined
      || v.markdown !== undefined
      || v.contentJson !== undefined
      || v.folderId !== undefined
      || v.position !== undefined,
    { message: 'No fields to update' },
  )

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  const { workspace } = await assertDocumentMembership(user.id, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const document = await updateUserDocument(user.id, id, input, key)
  return { document }
})
