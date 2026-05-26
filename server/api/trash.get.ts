import { z } from 'zod'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders } from '~/server/database/schema'
import { assertWorkspaceAccess } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { decryptDocument, decryptFolder } from '~/server/utils/encrypted-entities'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
})

/**
 * List soft-deleted documents and folders for the given workspace,
 * grouped/sorted by deletedAt desc (most recently trashed first).
 *
 * Document payload is lightweight (no markdown / contentJson) to keep the
 * trash page fast. Folder rows are returned in full.
 */
export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, Query.parse)
  await assertWorkspaceAccess(event, q.workspaceId)
  const dek = await getDek(event)

  const db = useDb()

  const docRows = await db
    .select({
      id: documents.id,
      workspaceId: documents.workspaceId,
      folderId: documents.folderId,
      title: documents.title,
      position: documents.position,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(and(eq(documents.workspaceId, q.workspaceId), isNotNull(documents.deletedAt)))
    .orderBy(desc(documents.deletedAt), desc(documents.id))

  const folderRows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.workspaceId, q.workspaceId), isNotNull(folders.deletedAt)))
    .orderBy(desc(folders.deletedAt), desc(folders.id))

  return {
    documents: docRows.map(d => decryptDocument(d, dek)),
    folders: folderRows.map(f => decryptFolder(f, dek)),
  }
})
