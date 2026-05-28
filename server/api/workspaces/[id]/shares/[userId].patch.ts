/**
 * Change a member's role (editor ↔ viewer). Owner-only. Owner's own row
 * cannot be downgraded — `updateShareRole` rejects that.
 */
import { z } from 'zod'
import { createError, defineEventHandler, getRouterParam, readValidatedBody } from 'h3'
import { assertWorkspaceOwner, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'
import { updateShareRole } from '~/server/utils/workspace-share'

const Body = z.object({
  role: z.enum(['editor', 'viewer']),
})

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  const userIdRaw = getRouterParam(event, 'userId')
  const targetUserId = Number(userIdRaw)
  if (!userIdRaw || !Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid userId' })
  }
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  const workspace = await assertWorkspaceOwner(user.id, workspaceId)
  await updateShareRole({
    workspace,
    ownerId: user.id,
    targetUserId,
    role: input.role,
  })
  return { ok: true as const }
})
