import { z } from 'zod'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { mcpTokens } from '~/server/database/schema'
import { deriveTokenWrapKey, wrap } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'
import { generateMcpToken, hashMcpToken, tokenPrefix } from '~/server/utils/mcpAuth'

const Body = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .default({})

/**
 * Create a new MCP token for the authenticated user. The clear-text token
 * is returned ONCE in the response (`token` field). The server only
 * persists `tokenHash` + `prefix`.
 *
 * Encryption: when the user has at-rest encryption enabled (everyone post
 * the encryption rollout) we wrap the user's DEK with a key derived from
 * the bearer (HKDF) and store the wrapped DEK on the token row. MCP
 * requests then unwrap the DEK from the row at auth-time — no session,
 * no password, just the bearer.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  if (!dek) {
    // Encryption is enabled for everyone going forward; we refuse to mint
    // an MCP token that can't decrypt the user's data — it would silently
    // surface ciphertext to Claude Desktop.
    throw createError({
      statusCode: 412,
      statusMessage: 'session_missing_dek',
      data: { detail: 'Log out and back in to refresh your session, then create the token.' },
    })
  }
  const input = await readValidatedBody(event, Body.parse)

  const token = generateMcpToken()
  const tokenHash = hashMcpToken(token)
  const prefix = tokenPrefix(token)
  const wrapKey = deriveTokenWrapKey(token)
  const wrappedDek = wrap(dek, wrapKey)

  const db = useDb()
  const [created] = await db
    .insert(mcpTokens)
    .values({
      userId: user.id,
      name: input.name ?? null,
      tokenHash,
      prefix,
      wrappedDek,
    })
    .returning({
      id: mcpTokens.id,
      name: mcpTokens.name,
      prefix: mcpTokens.prefix,
      lastUsedAt: mcpTokens.lastUsedAt,
      createdAt: mcpTokens.createdAt,
    })

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create token' })
  }

  return { token, mcpToken: created }
})
