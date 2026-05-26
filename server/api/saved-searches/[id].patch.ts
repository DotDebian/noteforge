import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { savedSearches } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const QuerySchema = z.object({
  q: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  folderId: z.number().int().positive().nullable().optional(),
  dateFrom: z.string().max(40).nullable().optional(),
  dateTo: z.string().max(40).nullable().optional(),
  sort: z.enum(['relevance', 'recent', 'oldest']).optional(),
})

const Body = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    query: QuerySchema.optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine(v => v.name !== undefined || v.query !== undefined || v.position !== undefined, {
    message: 'No fields to update',
  })

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)

  const db = useDb()
  const [existing] = await db
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.id, id))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Saved search not found' })
  }
  if (existing.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const patch: Partial<typeof savedSearches.$inferInsert> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.query !== undefined) patch.queryJson = input.query
  if (input.position !== undefined) patch.position = input.position

  const [updated] = await db
    .update(savedSearches)
    .set(patch)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, user.id)))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Saved search not found' })
  }

  return { savedSearch: updated }
})
