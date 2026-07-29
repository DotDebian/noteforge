import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { OauthClient } from '~/server/database/schema'

/**
 * Pure policy half of the OAuth authorization server: credential shapes,
 * PKCE verification, redirect-URI matching. No h3, no database — everything
 * here is a function of its arguments.
 *
 * Split out from `oauth.ts` on purpose. These are the checks that decide
 * whether a request gets a token at all, so they're the ones worth unit
 * testing (`tests/oauth.test.ts`), and vitest can't resolve `h3` from the
 * pnpm store. Statefull flow lives in `oauth.ts`, which re-exports this
 * surface so callers only ever import one module.
 */

/** The only scope we issue. Requested scopes are ignored and this is granted. */
export const OAUTH_SCOPE = 'mcp'

/** Display-only length for secret prefixes, mirroring `mcpAuth.tokenPrefix`. */
export const PREFIX_LEN = 11

/** Redirect URIs Claude uses for custom connectors — pre-filled on new clients. */
export const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]

export const ACCESS_TOKEN_PREFIX = 'nfat_'
export const REFRESH_TOKEN_PREFIX = 'nfrt_'
export const AUTH_CODE_PREFIX = 'nfac_'
const CLIENT_ID_PREFIX = 'nfc_'
const CLIENT_SECRET_PREFIX = 'nfcs_'

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** Deterministic digest — lets a UNIQUE INDEX give O(1) lookups on 256-bit secrets. */
export function hashOauthSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function generateClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`
}

export function generateClientSecret(): string {
  return randomToken(CLIENT_SECRET_PREFIX)
}

export function secretPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LEN)
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // Length is not secret here (both sides are fixed-width digests), and
  // timingSafeEqual throws on a mismatch, so the early return is required.
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function verifyClientSecret(client: OauthClient, secret: string): boolean {
  if (!secret) return false
  return constantTimeEqual(client.clientSecretHash, hashOauthSecret(secret))
}

/**
 * Verify an S256 PKCE challenge. `plain` is not supported by design: echoing
 * the challenge back as the verifier must fail, which is what stops a
 * downgraded client from neutralising PKCE.
 */
export function verifyPkce(codeChallenge: string, codeVerifier: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  return constantTimeEqual(codeChallenge, computed)
}

/**
 * Redirect URI check. Registered URIs match EXACTLY (OAuth 2.1 forbids prefix
 * matching — anything looser turns the authorization endpoint into an open
 * redirect that hands out codes), plus a loopback allowance: native clients
 * like `mcp-remote` and the MCP Inspector bind an ephemeral localhost port, so
 * pinning it at registration time is impossible. Loopback is only reachable
 * from the user's own machine, which is why RFC 8252 §7.3 carves it out.
 */
export function isRedirectUriAllowed(client: OauthClient, redirectUri: string): boolean {
  if (!redirectUri) return false
  if (client.redirectUris.includes(redirectUri)) return true

  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  }
  catch {
    return false
  }
  return (
    parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
  )
}
