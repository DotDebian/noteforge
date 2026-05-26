import { and, eq, inArray } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders } from '~/server/database/schema'
import { assertFolderAccess, parseIdParam } from '~/server/utils/access'

/**
 * Restore a soft-deleted folder: clear `deletedAt` on the folder AND on
 * every descendant folder / document that shares the SAME deletedAt
 * timestamp (= was trashed together with this folder).
 *
 * Children that were independently trashed earlier (different timestamp)
 * are intentionally left in the trash.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const folder = await assertFolderAccess(event, id)

  if (folder.deletedAt == null) {
    throw createError({ statusCode: 400, statusMessage: 'Folder is not trashed' })
  }
  const groupTs = folder.deletedAt
  const groupTsMs = groupTs.getTime()

  const db = useDb()

  // 1. Walk descendants in the *trashed* state and keep only those whose
  // deletedAt matches groupTs (i.e. they were trashed in the same op).
  const collected = new Set<number>([id])
  let frontier: number[] = [id]
  while (frontier.length > 0) {
    const children = await db
      .select({ id: folders.id, deletedAt: folders.deletedAt })
      .from(folders)
      .where(inArray(folders.parentId, frontier))
    const next: number[] = []
    for (const c of children) {
      if (collected.has(c.id)) continue
      if (c.deletedAt == null) continue
      if (c.deletedAt.getTime() !== groupTsMs) continue
      collected.add(c.id)
      next.push(c.id)
    }
    frontier = next
  }
  const folderIds = [...collected]

  // 2. Restore the folders.
  const [restored] = await db
    .update(folders)
    .set({ deletedAt: null })
    .where(eq(folders.id, id))
    .returning()

  if (folderIds.length > 1) {
    await db
      .update(folders)
      .set({ deletedAt: null })
      .where(inArray(folders.id, folderIds))
  }

  // 3. Restore documents that live in any of those folders AND share the
  // same deletedAt timestamp.
  await db
    .update(documents)
    .set({ deletedAt: null })
    .where(and(inArray(documents.folderId, folderIds), eq(documents.deletedAt, groupTs)))

  if (!restored) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }
  return { folder: restored }
})
