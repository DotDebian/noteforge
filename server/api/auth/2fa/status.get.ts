/**
 * GET /api/auth/2fa/status — quick check used by the settings UI.
 *
 * `enabled` flips to true once the user verifies their first TOTP code.
 * `enrollmentStarted` covers the in-between state where a secret has been
 * generated but never verified (e.g. user closed the dialog mid-setup).
 */
import { eq } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { userTotp } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const [row] = await db
    .select({
      enabled: userTotp.enabled,
      enabledAt: userTotp.enabledAt,
      createdAt: userTotp.createdAt,
    })
    .from(userTotp)
    .where(eq(userTotp.userId, user.id))
    .limit(1)

  if (!row) {
    return { enabled: false, enrollmentStarted: false, enabledAt: null }
  }

  return {
    enabled: row.enabled === true,
    enrollmentStarted: row.enabled === false,
    enabledAt: row.enabledAt ?? null,
  }
})
