import { eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders, workspaces } from '~/server/database/schema'
import { assertWorkspaceOwner, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  // Owner-only — destroying a shared workspace must not be possible from
  // an editor/viewer session.
  await assertWorkspaceOwner(user.id, id)

  const db = useDb()

  // Documents and folders have FK with ON DELETE CASCADE on workspace_id,
  // so deleting the workspace cascades. We also clean up explicitly to keep
  // things tidy if foreign_keys pragma is ever disabled.
  await db.delete(documents).where(eq(documents.workspaceId, id))
  await db.delete(folders).where(eq(folders.workspaceId, id))
  await db.delete(workspaces).where(eq(workspaces.id, id))

  return { ok: true }
})
