import { eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders, workspaces } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  await assertWorkspaceAccess(event, id)

  const db = useDb()

  // Documents and folders have FK with ON DELETE CASCADE on workspace_id,
  // so deleting the workspace cascades. We also clean up explicitly to keep
  // things tidy if foreign_keys pragma is ever disabled.
  await db.delete(documents).where(eq(documents.workspaceId, id))
  await db.delete(folders).where(eq(folders.workspaceId, id))
  await db.delete(workspaces).where(eq(workspaces.id, id))

  return { ok: true }
})
