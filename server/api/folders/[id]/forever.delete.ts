import { eq, inArray } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders } from '~/server/database/schema'
import { assertFolderAccess, parseIdParam } from '~/server/utils/access'

/**
 * Permanently delete a folder and its entire subtree (folders + docs).
 * Requires the folder to already be in the trash.
 *
 * Mirrors the manual cascade pattern used by the original delete handler
 * because there is no FK on `folders.parentId`. Documents are hard-deleted
 * (we don't reparent — caller asked for permanent removal); `doc_analyses`
 * and `doc_chunks` cascade automatically via their FKs to documents.
 */
async function collectSubtreeFolderIds(rootId: number): Promise<number[]> {
  const db = useDb()
  const collected = new Set<number>([rootId])
  let frontier: number[] = [rootId]
  while (frontier.length > 0) {
    const children = await db
      .select({ id: folders.id })
      .from(folders)
      .where(inArray(folders.parentId, frontier))
    const next: number[] = []
    for (const c of children) {
      if (!collected.has(c.id)) {
        collected.add(c.id)
        next.push(c.id)
      }
    }
    frontier = next
  }
  return [...collected]
}

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const folder = await assertFolderAccess(event, id)

  if (folder.deletedAt == null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Folder must be in trash before permanent deletion',
    })
  }

  const db = useDb()
  const folderIds = await collectSubtreeFolderIds(id)

  // Hard-delete every document whose folderId is in the subtree.
  await db.delete(documents).where(inArray(documents.folderId, folderIds))

  // Hard-delete the folders themselves. Drop children before parents to
  // avoid any potential FK shenanigans, though here parentId has no FK.
  if (folderIds.length > 1) {
    await db.delete(folders).where(inArray(folders.id, folderIds))
  }
  else {
    await db.delete(folders).where(eq(folders.id, id))
  }
  return { ok: true }
})
