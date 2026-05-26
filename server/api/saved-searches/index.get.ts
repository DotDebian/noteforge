import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { useDb } from '~/server/database/client'
import { savedSearches } from '~/server/database/schema'
import { assertWorkspaceAccess } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
})

/**
 * List the current user's saved searches in `workspaceId`, sorted by
 * `position` (ascending). Workspace ownership is enforced via
 * `assertWorkspaceAccess`.
 */
export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, Query.parse)
  const user = await requireUser(event)
  await assertWorkspaceAccess(event, q.workspaceId)

  const db = useDb()
  const rows = await db
    .select()
    .from(savedSearches)
    .where(and(
      eq(savedSearches.userId, user.id),
      eq(savedSearches.workspaceId, q.workspaceId),
    ))
    .orderBy(asc(savedSearches.position), asc(savedSearches.id))

  return { savedSearches: rows }
})
