import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { isDailyNoteTitle, listUserDocuments } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKey } from '~/server/utils/workspace-key'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
  folderId: z
    .union([z.literal('root'), z.coerce.number().int().positive()])
    .optional(),
  // Journal entries (title = YYYY-MM-DD) are hidden by default so they
  // don't pollute the sidebar; the calendar widget surfaces them. Opt-in
  // for callers that genuinely need the full list (none today).
  includeJournal: z.coerce.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, Query.parse)
  const user = await requireUser(event)
  const key = await getWorkspaceKey(event, q.workspaceId)
  const documents = await listUserDocuments(user.id, q.workspaceId, {
    folderId: q.folderId,
  }, key)
  const filtered = q.includeJournal
    ? documents
    : documents.filter(d => !isDailyNoteTitle(d.title))
  return { documents: filtered }
})
