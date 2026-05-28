/**
 * Revoke a member's access. Owner-only. The owner's own row is
 * protected — `revokeShare` refuses `targetUserId === ownerId`.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { assertWorkspaceOwner, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'
import { revokeShare } from '~/server/utils/workspace-share'

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  const userIdRaw = getRouterParam(event, 'userId')
  const targetUserId = Number(userIdRaw)
  if (!userIdRaw || !Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid userId' })
  }
  const user = await requireUser(event)
  await assertWorkspaceOwner(user.id, workspaceId)
  await revokeShare({ workspaceId, ownerId: user.id, targetUserId })
  return { ok: true as const }
})
