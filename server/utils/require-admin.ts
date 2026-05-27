import type { H3Event } from 'h3'
import { createError } from 'h3'
import { requireUser } from './require-user'
import type { User } from '~/server/database/schema'

/**
 * Like `requireUser`, but additionally asserts `isAdmin = true`.
 * Throws 403 for authenticated non-admin users.
 */
export async function requireAdmin(event: H3Event): Promise<User> {
  const user = await requireUser(event)
  if (!user.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return user
}
