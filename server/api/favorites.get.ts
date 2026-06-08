import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, favorites } from '~/server/database/schema'
import { assertWorkspaceAccess } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { decryptField } from '~/server/utils/crypto'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKey } from '~/server/utils/workspace-key'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
})

/**
 * List the current user's favorited documents within a given workspace.
 *
 * Excludes soft-deleted docs via `activeDocsWhere()`. Sorted by favorite
 * `createdAt` desc (most recently pinned first).
 */
export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, Query.parse)
  const user = await requireUser(event)
  await assertWorkspaceAccess(event, q.workspaceId)
  // Titles are encrypted under the workspace's key (DEK for solo, WEK for
  // shared) — `getDek` alone can't decrypt a shared workspace's titles.
  const dek = await getWorkspaceKey(event, q.workspaceId)

  const db = useDb()
  const rows = await db
    .select({
      docId: favorites.docId,
      title: documents.title,
      createdAt: favorites.createdAt,
    })
    .from(favorites)
    .innerJoin(documents, eq(documents.id, favorites.docId))
    .where(
      and(
        eq(favorites.userId, user.id),
        eq(documents.workspaceId, q.workspaceId),
        activeDocsWhere(),
      ),
    )
    .orderBy(desc(favorites.createdAt))

  return {
    favorites: rows.map(r => ({ ...r, title: decryptField(r.title, dek) })),
  }
})
