/**
 * POST /api/workspaces/:id/daily-note
 *
 * Find-or-create the journal note for `date` (YYYY-MM-DD). Used by the
 * sidebar calendar widget: clicking a day calls this, then navigates to
 * `/w/:id/d/:docId`.
 */
import { z } from 'zod'
import { requireUser } from '~/server/utils/require-user'
import { findOrCreateDailyNote } from '~/server/utils/notes'

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const wsId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(wsId) || wsId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_workspace_id' })
  }
  const body = await readValidatedBody(event, (v) => Body.parse(v))
  const { document, created } = await findOrCreateDailyNote(user.id, wsId, body.date)
  return { document, created }
})
