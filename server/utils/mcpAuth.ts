import type { H3Event } from 'h3'
import { createError, getRequestHeader, setHeader } from 'h3'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { mcpTokens, users, type User } from '~/server/database/schema'
import { deriveTokenWrapKey, unwrap } from './crypto'
import { ACCESS_TOKEN_PREFIX, publicOrigin, resolveOauthAccessToken } from './oauth'

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
  /**
   * Row id of the validated `mcp_tokens` entry — surfaced for call-log
   * attribution. `null` when the caller authenticated with an OAuth access
   * token instead (`mcp_call_logs.token_id` FKs `mcp_tokens`, so an OAuth
   * grant id has nowhere to go there; the log still carries `userId`).
   */
  tokenId: number | null
}

/**
 * 401 carrying the RFC 9728 challenge. MCP clients that speak OAuth (Claude's
 * custom connectors) bootstrap discovery from this header: they read
 * `resource_metadata`, fetch it, and follow it to the authorization server.
 * Without the header, claude.ai has no way to know where to send the user.
 */
function unauthorized(event: H3Event, message: string): ReturnType<typeof createError> {
  setHeader(
    event,
    'www-authenticate',
    `Bearer resource_metadata="${publicOrigin(event)}/.well-known/oauth-protected-resource"`,
  )
  return createError({ statusCode: 401, statusMessage: message })
}

/**
 * Validate the `Authorization: Bearer …` header on an MCP request.
 *
 * Two credential families are accepted, distinguished by prefix:
 *  - `nf_…`   — a static token from `mcp_tokens` (Claude Desktop via
 *               `mcp-remote`, scripts, anything that can set a header),
 *  - `nfat_…` — an OAuth access token issued by our own authorization server
 *               (claude.ai custom connectors, which cannot send headers).
 *
 * Either way the result is the same shape: the user row plus the DEK unwrapped
 * from whichever artefact authenticated the call.
 */
export async function requireMcpUser(event: H3Event): Promise<McpAuthResult> {
  const header = getRequestHeader(event, 'authorization')
    ?? getRequestHeader(event, 'Authorization')
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized(event, 'Missing bearer token')
  }

  const token = header.slice(7).trim()

  // OAuth access token — checked first because `nfat_` would otherwise fall
  // through the `nf_` format guard below and 401 with a misleading message.
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const grant = await resolveOauthAccessToken(token)
    if (!grant) {
      throw unauthorized(event, 'Invalid, expired or revoked access token')
    }
    const [oauthUser] = await useDb()
      .select()
      .from(users)
      .where(eq(users.id, grant.userId))
      .limit(1)
    if (!oauthUser) {
      throw unauthorized(event, 'User no longer exists')
    }
    return { user: oauthUser, dek: grant.dek, tokenId: null }
  }

  if (!token.startsWith('nf_') || token.length < 16) {
    throw unauthorized(event, 'Invalid token format')
  }

  const hash = hashMcpToken(token)
  const db = useDb()
  const [row] = await db
    .select({ id: mcpTokens.id, userId: mcpTokens.userId, wrappedDek: mcpTokens.wrappedDek })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hash), isNull(mcpTokens.revokedAt)))
    .limit(1)

  if (!row) {
    throw unauthorized(event, 'Invalid or revoked token')
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)

  if (!user) {
    throw unauthorized(event, 'User no longer exists')
  }

  let dek: Buffer | null = null
  if (row.wrappedDek) {
    try {
      const wrapKey = deriveTokenWrapKey(token)
      dek = unwrap(row.wrappedDek, wrapKey)
    }
    catch (err) {
      console.error('[mcp-auth] failed to unwrap DEK for token', row.id, err)
      throw unauthorized(event, 'Token cannot decrypt data — revoke and re-issue')
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
