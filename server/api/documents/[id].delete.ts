import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { softDeleteUserDocument } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'

/**
 * Soft-delete a document: stamp `deletedAt = now()`. Idempotent — a re-call
 * on an already-trashed document returns the existing timestamp instead of
 * 400, keeping the sidebar UX simple if a stale click arrives twice.
 *
 * Permanent deletion goes through `[id]/forever.delete.ts`.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  return await softDeleteUserDocument(user.id, id)
})
