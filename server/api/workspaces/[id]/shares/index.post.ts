/**
 * Share `workspaceId` with another user by email. Owner-only.
 *
 * If the workspace is still in `'dek'` mode this endpoint upgrades it to
 * `'wek'` inline: generate a WEK, re-encrypt every content-bearing row
 * from DEK→WEK, seal the WEK for the owner (their own membership row)
 * and the new member. Subsequent shares re-use the same WEK.
 *
 * Errors:
 *  - 404 `missing_target_user`      — no account exists for that email.
 *  - 409 `target_is_owner`          — the owner can't share with themselves.
 *  - 409 `already_shared`           — that user already has access.
 *  - 409 `missing_target_keypair`   — the invitee hasn't logged in since
 *    the share-rollout deploy. They need to log in once to get a keypair
 *    provisioned (lazy backfill in login.post.ts) — surfaces a clear
 *    message in the UI so the owner can ping them.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { users } from '~/server/database/schema'
import { assertWorkspaceOwner, parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'
import { shareWorkspaceWith } from '~/server/utils/workspace-share'

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  role: z.enum(['editor', 'viewer']),
})

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  const user = await requireUser(event)
  const input = await readValidatedBody(event, Body.parse)
  const workspace = await assertWorkspaceOwner(user.id, workspaceId)

  const dek = await getDek(event)
  if (!dek) {
    throw createError({ statusCode: 409, statusMessage: 'session_missing_dek' })
  }

  const db = useDb()
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'missing_target_user' })
  }

  try {
    const result = await shareWorkspaceWith({
      workspace,
      ownerId: user.id,
      ownerDek: dek,
      targetUserId: target.id,
      role: input.role,
    })
    return { share: result.share, upgraded: result.upgraded }
  }
  catch (err) {
    const e = err as Error & { statusCode?: number }
    // Drizzle / sqlite-side unique-index violation surfaces as a generic
    // error — map to a friendly `already_shared`.
    if (typeof e.message === 'string' && /UNIQUE constraint failed: workspace_shares/.test(e.message)) {
      throw createError({ statusCode: 409, statusMessage: 'already_shared' })
    }
    throw createError({ statusCode: e.statusCode ?? 500, statusMessage: e.message ?? 'share_failed' })
  }
})
