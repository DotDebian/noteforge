import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { workspaces } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { decryptWorkspace, encryptWorkspace } from '~/server/utils/encrypted-entities'

const Body = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    emoji: z.string().trim().max(8).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.emoji !== undefined, {
    message: 'No fields to update',
  })

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  await assertWorkspaceAccess(event, id)
  const input = await readValidatedBody(event, Body.parse)
  const dek = await getDek(event)

  const patch: Partial<typeof workspaces.$inferInsert> = {}
  if (input.name !== undefined) patch.name = encryptWorkspace({ name: input.name }, dek).name!
  if (input.emoji !== undefined) patch.emoji = input.emoji

  const db = useDb()
  const [updated] = await db
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, id))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }
  return { workspace: decryptWorkspace(updated, dek) }
})
