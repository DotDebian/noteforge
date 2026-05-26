import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { savedSearches } from '~/server/database/schema'
import { assertWorkspaceAccess } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const QuerySchema = z.object({
  q: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  folderId: z.number().int().positive().nullable().optional(),
  dateFrom: z.string().max(40).nullable().optional(),
  dateTo: z.string().max(40).nullable().optional(),
  sort: z.enum(['relevance', 'recent', 'oldest']).optional(),
})

const Body = z.object({
  workspaceId: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  query: QuerySchema.default({}),
})

/**
 * Create a saved search for the current user. `position` is computed as
 * `max(position) + 1` within the user/workspace scope.
 */
export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  await assertWorkspaceAccess(event, input.workspaceId)

  const db = useDb()

  const [{ maxPos = 0 } = { maxPos: 0 }] = await db
    .select({ maxPos: sql<number>`coalesce(max(${savedSearches.position}), 0)`.mapWith(Number) })
    .from(savedSearches)
    .where(and(
      eq(savedSearches.userId, user.id),
      eq(savedSearches.workspaceId, input.workspaceId),
    ))

  const [created] = await db
    .insert(savedSearches)
    .values({
      userId: user.id,
      workspaceId: input.workspaceId,
      name: input.name,
      queryJson: input.query,
      position: (maxPos ?? 0) + 1,
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create saved search' })
  }

  return { savedSearch: created }
})
