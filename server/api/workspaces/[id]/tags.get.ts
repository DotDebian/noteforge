/**
 * GET /api/workspaces/:id/tags
 *
 * Returns the distinct set of tags currently produced by `doc_analyses.tags`
 * across the active (non-trashed) documents in this workspace, with the
 * matching doc ids and counts. Used by the workspace tags page.
 *
 * Aggregation lives in `listUserWorkspaceTags` (notes.ts) — shared with the
 * MCP `list_tags` tool. The key comes from `getWorkspaceKey` so shared
 * (WEK) workspaces decrypt correctly too.
 */
import { defineEventHandler } from 'h3'
import { parseIdParam } from '~/server/utils/access'
import { listUserWorkspaceTags } from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKey } from '~/server/utils/workspace-key'

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  const user = await requireUser(event)
  const key = await getWorkspaceKey(event, workspaceId)
  return { tags: await listUserWorkspaceTags(user.id, workspaceId, key) }
})
