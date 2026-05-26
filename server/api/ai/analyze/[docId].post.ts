import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { analyzeUserDocument } from '~/server/utils/notes'
import { applyRateLimit } from '~/server/utils/rate-limit'
import { requireUser } from '~/server/utils/require-user'

/**
 * Mistral JSON-mode analysis: summary + tags + questions + action items, then
 * fire-and-forget re-embed of the doc's chunks + summary vector. Shared logic
 * lives in `server/utils/notes.ts` so the MCP `analyze_document` tool runs
 * exactly the same flow.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  applyRateLimit(event, user.id, 'analyze')
  const docId = parseIdParam(event, 'docId')
  const analysis = await analyzeUserDocument(user.id, docId, dek)
  return { analysis }
})
