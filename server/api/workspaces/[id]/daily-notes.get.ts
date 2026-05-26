/**
 * GET /api/workspaces/:id/daily-notes?month=YYYY-MM
 *
 * Returns the list of `YYYY-MM-DD` dates that already have a journal note
 * in this workspace for the given month. The sidebar calendar uses this
 * to render presence dots on the calendar grid.
 */
import { z } from 'zod'
import { requireUser } from '~/server/utils/require-user'
import { listDailyNotesForMonth } from '~/server/utils/notes'

const Query = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const wsId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(wsId) || wsId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_workspace_id' })
  }
  const q = await getValidatedQuery(event, (v) => Query.parse(v))
  const dates = await listDailyNotesForMonth(user.id, wsId, q.month)
  return { dates }
})
