import type { H3Event } from 'h3'
import { createError, getRequestHeader } from 'h3'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { mcpTokens, users, type User } from '~/server/database/schema'
import { deriveTokenWrapKey, unwrap } from './crypto'

/**
 * MCP bearer tokens. Distinct from password hashing in `auth.ts`:
 *  - the value is high-entropy random (256 bits) so a deterministic hash
 *    is enough; we do NOT need bcrypt's slow / salted scheme,
 *  - SHA-256 hex is deterministic which lets us put a UNIQUE INDEX on
 *    `mcp_tokens.token_hash` and look the row up in O(1) per request,
 *  - we only display the `prefix` to users (e.g. `nf_abc12345`) — the
 *    full clear token is shown exactly once on creation.
 *
 * Encryption integration: every token row stores a copy of the user's
 * DEK, wrapped under a key derived from the bearer via HKDF. This means
 * MCP requests can decrypt user data without ever seeing the user's
 * password. Tokens minted before the encryption rollout have
 * `wrappedDek = null` and operate in plaintext-passthrough mode (their
 * users have `encryptionEnabled = 0` until they log in via the web UI).
 */

/** Token prefix length stored on the row for UI display. `nf_` + 8 random chars. */
const PREFIX_LEN = 11

/** Generate a fresh clear-text bearer token. Shown once, never persisted as-is. */
export function generateMcpToken(): string {
  const body = randomBytes(32).toString('base64url')
  return `nf_${body}`
}

/** Deterministic SHA-256 hex digest — what we store and look up by. */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Short identifying chunk safe to display in the UI. */
export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LEN)
}

export interface McpAuthResult {
  user: User
  /** Per-user DEK unwrapped from the token row. `null` for legacy tokens with no wrap. */
  dek: Buffer | null
  /** Row id of the validated `mcp_tokens` entry — surfaced for call-log attribution. */
  tokenId: number
}

/**
 * Validate the `Authorization: Bearer …` header on an MCP request.
 *
 * Returns the authenticated user (full row) and the unwrapped DEK, or
 * throws 401. Updates `last_used_at` fire-and-forget — the request must
 * not wait on it.
 */
export async function requireMcpUser(event: H3Event): Promise<McpAuthResult> {
  const header = getRequestHeader(event, 'authorization')
    ?? getRequestHeader(event, 'Authorization')
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Missing bearer token',
    })
  }

  const token = header.slice(7).trim()
  if (!token.startsWith('nf_') || token.length < 16) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid token format' })
  }

  const hash = hashMcpToken(token)
  const db = useDb()
  const [row] = await db
    .select({ id: mcpTokens.id, userId: mcpTokens.userId, wrappedDek: mcpTokens.wrappedDek })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hash), isNull(mcpTokens.revokedAt)))
    .limit(1)

  if (!row) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid or revoked token',
    })
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)

  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'User no longer exists' })
  }

  let dek: Buffer | null = null
  if (row.wrappedDek) {
    try {
      const wrapKey = deriveTokenWrapKey(token)
      dek = unwrap(row.wrappedDek, wrapKey)
    }
    catch (err) {
      console.error('[mcp-auth] failed to unwrap DEK for token', row.id, err)
      throw createError({
        statusCode: 401,
        statusMessage: 'Token cannot decrypt data — revoke and re-issue',
      })
    }
  }

  // Fire-and-forget: do not block the request on the bookkeeping write.
  void db
    .update(mcpTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpTokens.id, row.id))
    .catch((err: unknown) => {
      console.error('[mcp-auth] failed to update lastUsedAt', err)
    })

  return { user, dek, tokenId: row.id }
}
