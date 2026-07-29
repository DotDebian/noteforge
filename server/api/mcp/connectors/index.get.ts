import { and, desc, eq, isNull } from 'drizzle-orm'
import { defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { oauthClients } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'

/**
 * List the current user's active OAuth connectors (Claude custom connectors).
 * Mirrors `mcp/tokens/index.get.ts`: the secret hash never leaves the server,
 * only the display prefix.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()

  const rows = await db
    .select({
      id: oauthClients.id,
      name: oauthClients.name,
      clientId: oauthClients.clientId,
      secretPrefix: oauthClients.secretPrefix,
      lastUsedAt: oauthClients.lastUsedAt,
      createdAt: oauthClients.createdAt,
    })
    .from(oauthClients)
    .where(and(eq(oauthClients.userId, user.id), isNull(oauthClients.revokedAt)))
    .orderBy(desc(oauthClients.createdAt))

  return { connectors: rows }
})
