/**
 * Coverage for the OAuth authorization-server primitives that gate access to
 * the MCP endpoint. These are the pure, security-critical halves of
 * `server/utils/oauth.ts`:
 *
 * - PKCE S256 verification (the only thing standing between a leaked
 *   authorization code and a usable token, since Claude's client secret lives
 *   on our side of the flow too)
 * - redirect-URI policy: exact match for registered URIs, plus the RFC 8252
 *   loopback carve-out — a prefix or subdomain match here would be an open
 *   redirect that hands out authorization codes
 * - credential generation / hashing invariants
 *
 * The DB-touching halves (code exchange, refresh rotation) are covered by
 * running the flow end to end, not here — `useDb()` connects lazily, which is
 * what makes importing this module in a unit test safe.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { OauthClient } from '~/server/database/schema'
import {
  DEFAULT_REDIRECT_URIS,
  generateClientId,
  generateClientSecret,
  hashOauthSecret,
  isRedirectUriAllowed,
  secretPrefix,
  verifyPkce,
} from '~/server/utils/oauth-policy'

/** Minimal client row — only the fields the redirect policy reads. */
function clientWith(redirectUris: string[]): OauthClient {
  return {
    id: 1,
    userId: 1,
    name: 'test',
    clientId: 'nfc_test',
    clientSecretHash: 'x',
    secretPrefix: 'nfcs_abc',
    redirectUris,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  }
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

describe('verifyPkce', () => {
  const verifier = randomBytes(48).toString('base64url')

  it('accepts the verifier its challenge was derived from', () => {
    expect(verifyPkce(challengeFor(verifier), verifier)).toBe(true)
  })

  it('rejects a different verifier', () => {
    const other = randomBytes(48).toString('base64url')
    expect(verifyPkce(challengeFor(verifier), other)).toBe(false)
  })

  it('rejects an empty verifier', () => {
    expect(verifyPkce(challengeFor(verifier), '')).toBe(false)
  })

  it('rejects the `plain` method — challenge echoed back as the verifier', () => {
    // A challenge is 43 chars of base64url, so it passes the length guard;
    // only the S256 comparison stops it. This is the check that keeps a
    // downgraded client from defeating PKCE entirely.
    const challenge = challengeFor(verifier)
    expect(challenge.length).toBeGreaterThanOrEqual(43)
    expect(verifyPkce(challenge, challenge)).toBe(false)
  })

  it('rejects verifiers outside the RFC 7636 length bounds', () => {
    const short = 'a'.repeat(42)
    const long = 'a'.repeat(129)
    expect(verifyPkce(challengeFor(short), short)).toBe(false)
    expect(verifyPkce(challengeFor(long), long)).toBe(false)
  })
})

describe('isRedirectUriAllowed', () => {
  const client = clientWith(DEFAULT_REDIRECT_URIS)

  it('accepts a registered URI verbatim', () => {
    expect(isRedirectUriAllowed(client, 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isRedirectUriAllowed(client, 'https://claude.com/api/mcp/auth_callback')).toBe(true)
  })

  it('rejects an unregistered host', () => {
    expect(isRedirectUriAllowed(client, 'https://evil.example/callback')).toBe(false)
  })

  it('rejects prefix / suffix variations of a registered URI', () => {
    // OAuth 2.1 mandates exact matching precisely because these look close
    // enough to slip through a naive `startsWith`.
    expect(isRedirectUriAllowed(client, 'https://claude.ai/api/mcp/auth_callback/../../evil')).toBe(false)
    expect(isRedirectUriAllowed(client, 'https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(false)
    expect(isRedirectUriAllowed(client, 'https://claude.ai/api/mcp/auth_callback?next=x')).toBe(false)
  })

  it('accepts loopback on any port (RFC 8252 native-client carve-out)', () => {
    expect(isRedirectUriAllowed(client, 'http://127.0.0.1:51837/oauth/callback')).toBe(true)
    expect(isRedirectUriAllowed(client, 'http://localhost:6274/callback')).toBe(true)
  })

  it('does not extend the loopback carve-out to remote http hosts', () => {
    expect(isRedirectUriAllowed(client, 'http://evil.example/callback')).toBe(false)
    expect(isRedirectUriAllowed(client, 'http://127.0.0.1.evil.example/callback')).toBe(false)
  })

  it('rejects empty and unparseable values', () => {
    expect(isRedirectUriAllowed(client, '')).toBe(false)
    expect(isRedirectUriAllowed(client, 'not a url')).toBe(false)
  })
})

describe('credential generation', () => {
  it('mints distinct, prefixed client ids and secrets', () => {
    const idA = generateClientId()
    const idB = generateClientId()
    expect(idA.startsWith('nfc_')).toBe(true)
    expect(idA).not.toBe(idB)

    const secret = generateClientSecret()
    expect(secret.startsWith('nfcs_')).toBe(true)
    expect(secret).not.toBe(generateClientSecret())
  })

  it('hashes deterministically so the UNIQUE INDEX can do the lookup', () => {
    const secret = generateClientSecret()
    expect(hashOauthSecret(secret)).toBe(hashOauthSecret(secret))
    expect(hashOauthSecret(secret)).not.toBe(hashOauthSecret(generateClientSecret()))
    // Hex SHA-256.
    expect(hashOauthSecret(secret)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exposes only a short, non-reversible prefix for display', () => {
    const secret = generateClientSecret()
    const prefix = secretPrefix(secret)
    expect(prefix).toHaveLength(11)
    expect(secret.startsWith(prefix)).toBe(true)
    expect(prefix.length).toBeLessThan(secret.length / 2)
  })
})
