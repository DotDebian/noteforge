import type { H3Event } from 'h3'
import { createError, getRequestURL, setHeader } from 'h3'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import {
  oauthAuthCodes,
  oauthClients,
  oauthTokens,
  type OauthClient,
} from '~/server/database/schema'
import { deriveTokenWrapKey, unwrap, wrap } from './crypto'
// Values this module USES must be imported, not merely re-exported below:
// `export { X } from '…'` creates no local binding, and Nitro's auto-import
// does not fill the gap in the built bundle (it typechecks, then throws
// `X is not defined` at runtime — which is exactly how this bit).
import {
  ACCESS_TOKEN_PREFIX,
  AUTH_CODE_PREFIX,
  hashOauthSecret,
  OAUTH_SCOPE,
  randomToken,
  REFRESH_TOKEN_PREFIX,
  verifyPkce,
} from './oauth-policy'

// Single import surface for callers: the pure policy helpers stay usable as
// `~/server/utils/oauth` even though they live next door.
export {
  ACCESS_TOKEN_PREFIX,
  DEFAULT_REDIRECT_URIS,
  generateClientId,
  generateClientSecret,
  hashOauthSecret,
  isRedirectUriAllowed,
  OAUTH_SCOPE,
  REFRESH_TOKEN_PREFIX,
  secretPrefix,
  verifyClientSecret,
  verifyPkce,
} from './oauth-policy'

/**
 * Minimal OAuth 2.1 authorization server, scoped to a single resource:
 * NoteForge's own MCP endpoint (`/api/mcp`).
 *
 * Why this exists: `mcp_tokens` bearers work for Claude Desktop (through
 * `mcp-remote`, which forwards a static header), but claude.ai's "custom
 * connector" has no way to send a custom header — it only speaks OAuth.
 * So the user registers a *connector* here, gets a client id + secret, and
 * pastes them into Claude's advanced connector settings.
 *
 * Deliberate simplifications, all safe for a single-tenant self-hosted app:
 *  - one scope (`mcp`) — the connector gets the same surface as a bearer,
 *  - PKCE S256 is MANDATORY (no `plain`, no PKCE-less code flow),
 *  - no dynamic client registration: clients are minted from the UI, which
 *    keeps a stolen discovery document from creating usable credentials,
 *  - refresh rotates access + refresh in place on the same grant row.
 *
 * Encryption: the DEK travels code → access token → rotated access token,
 * re-wrapped at each hop under `deriveTokenWrapKey(<clear artefact>)`. It is
 * captured from the browser session at consent time, so the connector can
 * decrypt the user's notes without ever seeing their password.
 */

/* -------------------------------------------------------------------------- */
/*  Lifetimes                                                                  */
/* -------------------------------------------------------------------------- */

/** Authorization codes are single-use and short-lived. */
const AUTH_CODE_TTL_MS = 5 * 60 * 1000
/** Access tokens last a day; Claude refreshes silently well before that. */
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** Refresh tokens last a quarter, rotating (and extending) on every use. */
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Public origin of this deployment. Behind the prod reverse proxy the socket
 * sees `http://localhost:3000`, so `X-Forwarded-*` has to win — the issuer we
 * advertise must match the URL the connector actually calls, or Claude
 * rejects the discovery document.
 */
export function publicOrigin(event: H3Event): string {
  const override = process.env.NOTEFORGE_PUBLIC_URL
  if (override) return override.replace(/\/+$/, '')
  return getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
}

/** Canonical resource identifier (RFC 8707 audience) for the MCP endpoint. */
export function mcpResourceUrl(event: H3Event): string {
  return `${publicOrigin(event)}/api/mcp`
}

/**
 * OAuth metadata and the token endpoint are fetched cross-origin by browser
 * based clients (MCP Inspector, `mcp-remote`), so they need permissive CORS.
 * These responses carry no cookies and no user data — only public metadata or
 * a token minted from credentials the caller already holds.
 */
export function setOauthCors(event: H3Event): void {
  setHeader(event, 'access-control-allow-origin', '*')
  setHeader(event, 'access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  setHeader(
    event,
    'access-control-allow-headers',
    'authorization, content-type, accept, last-event-id, mcp-protocol-version, mcp-session-id',
  )
  // Without this a browser client can't read the 401 challenge and has no way
  // to discover the authorization server.
  setHeader(event, 'access-control-expose-headers', 'www-authenticate, mcp-session-id')
  // h3 types this one as a number (it's a delta-seconds header).
  setHeader(event, 'access-control-max-age', 86400)
}

/* -------------------------------------------------------------------------- */
/*  OAuth error shape                                                          */
/* -------------------------------------------------------------------------- */

/**
 * RFC 6749 §5.2 errors: the body must be `{error, error_description}`, not
 * H3's default `{statusMessage}` — Claude surfaces `error_description` to the
 * user, so a well-formed payload is what makes a failed connect diagnosable.
 */
export function oauthError(
  statusCode: number,
  error: string,
  description?: string,
): ReturnType<typeof createError> {
  return createError({
    statusCode,
    statusMessage: error,
    data: { error, error_description: description ?? error },
  })
}

/* -------------------------------------------------------------------------- */
/*  Clients                                                                    */
/* -------------------------------------------------------------------------- */

/** Look up an active client by its public id. Returns null on miss/revoked. */
export async function findOauthClient(clientId: string): Promise<OauthClient | null> {
  if (!clientId) return null
  const db = useDb()
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt)))
    .limit(1)
  return row ?? null
}

/* -------------------------------------------------------------------------- */
/*  Authorization codes                                                        */
/* -------------------------------------------------------------------------- */

export interface IssueCodeInput {
  client: OauthClient
  userId: number
  redirectUri: string
  codeChallenge: string
  resource: string | null
  /** DEK lifted from the consenting user's session; travels with the grant. */
  dek: Buffer | null
}

/** Mint a single-use authorization code carrying a wrapped copy of the DEK. */
export async function issueAuthorizationCode(input: IssueCodeInput): Promise<string> {
  const code = randomToken(AUTH_CODE_PREFIX)

  // Opportunistic GC. Codes live 5 minutes and are consumed once, so anything
  // past its expiry is dead weight — without this the table only ever grows.
  // Piggy-backing on the issue path keeps it free of a scheduled job, and the
  // index on `expires_at` makes the sweep cheap.
  void useDb()
    .delete(oauthAuthCodes)
    .where(lt(oauthAuthCodes.expiresAt, new Date()))
    .catch(() => { /* housekeeping only — never fail the authorization */ })

  await useDb().insert(oauthAuthCodes).values({
    clientRowId: input.client.id,
    userId: input.userId,
    codeHash: hashOauthSecret(code),
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    scope: OAUTH_SCOPE,
    wrappedDek: input.dek ? wrap(input.dek, deriveTokenWrapKey(code)) : null,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  })
  return code
}

/* -------------------------------------------------------------------------- */
/*  Token issuance                                                             */
/* -------------------------------------------------------------------------- */

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
}

function tokenPair(dek: Buffer | null) {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX)
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX)
  return {
    accessToken,
    refreshToken,
    accessTokenHash: hashOauthSecret(accessToken),
    refreshTokenHash: hashOauthSecret(refreshToken),
    wrappedDekAccess: dek ? wrap(dek, deriveTokenWrapKey(accessToken)) : null,
    wrappedDekRefresh: dek ? wrap(dek, deriveTokenWrapKey(refreshToken)) : null,
    accessExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  }
}

/**
 * Exchange an authorization code for a token pair. The code is consumed
 * atomically-ish: we stamp `consumedAt` before issuing, and a code that is
 * already consumed is rejected *and* revokes the tokens it produced — the
 * RFC 6749 §10.5 replay defence.
 */
export async function exchangeAuthorizationCode(opts: {
  client: OauthClient
  code: string
  redirectUri: string
  codeVerifier: string
}): Promise<IssuedTokens> {
  const db = useDb()
  const codeHash = hashOauthSecret(opts.code)
  const [row] = await db
    .select()
    .from(oauthAuthCodes)
    .where(eq(oauthAuthCodes.codeHash, codeHash))
    .limit(1)

  if (!row) throw oauthError(400, 'invalid_grant', 'Unknown authorization code.')

  if (row.consumedAt) {
    // Replayed code (RFC 6749 §10.5): deny, and burn the tokens THIS code
    // produced — scoped to the code, not to the client, so a retried request
    // can't take down the user's other working grants.
    await db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.authCodeId, row.id))
    throw oauthError(400, 'invalid_grant', 'Authorization code already used.')
  }
  if (row.clientRowId !== opts.client.id) {
    throw oauthError(400, 'invalid_grant', 'Authorization code was issued to another client.')
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw oauthError(400, 'invalid_grant', 'Authorization code expired.')
  }
  if (row.redirectUri !== opts.redirectUri) {
    throw oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.')
  }
  if (!verifyPkce(row.codeChallenge, opts.codeVerifier)) {
    throw oauthError(400, 'invalid_grant', 'PKCE verification failed.')
  }

  await db
    .update(oauthAuthCodes)
    .set({ consumedAt: new Date() })
    .where(eq(oauthAuthCodes.id, row.id))

  let dek: Buffer | null = null
  if (row.wrappedDek) {
    try {
      dek = unwrap(row.wrappedDek, deriveTokenWrapKey(opts.code))
    }
    catch (err) {
      console.error('[oauth] failed to unwrap DEK from authorization code', row.id, err)
      throw oauthError(400, 'invalid_grant', 'Authorization code is corrupt — restart the connection.')
    }
  }

  const pair = tokenPair(dek)
  await db.insert(oauthTokens).values({
    clientRowId: opts.client.id,
    userId: row.userId,
    authCodeId: row.id,
    accessTokenHash: pair.accessTokenHash,
    refreshTokenHash: pair.refreshTokenHash,
    wrappedDekAccess: pair.wrappedDekAccess,
    wrappedDekRefresh: pair.wrappedDekRefresh,
    scope: OAUTH_SCOPE,
    accessExpiresAt: pair.accessExpiresAt,
    refreshExpiresAt: pair.refreshExpiresAt,
  })

  void db
    .update(oauthClients)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthClients.id, opts.client.id))
    .catch(() => { /* bookkeeping only */ })

  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: OAUTH_SCOPE,
  }
}

/**
 * Rotate a grant from its refresh token. Both tokens are replaced in place on
 * the same row, so the previous access token stops working immediately.
 */
export async function refreshOauthGrant(opts: {
  client: OauthClient
  refreshToken: string
}): Promise<IssuedTokens> {
  const db = useDb()
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(
      eq(oauthTokens.refreshTokenHash, hashOauthSecret(opts.refreshToken)),
      isNull(oauthTokens.revokedAt),
    ))
    .limit(1)

  if (!row) throw oauthError(400, 'invalid_grant', 'Unknown or revoked refresh token.')
  if (row.clientRowId !== opts.client.id) {
    throw oauthError(400, 'invalid_grant', 'Refresh token was issued to another client.')
  }
  if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() < Date.now()) {
    throw oauthError(400, 'invalid_grant', 'Refresh token expired — reconnect the connector.')
  }

  let dek: Buffer | null = null
  if (row.wrappedDekRefresh) {
    try {
      dek = unwrap(row.wrappedDekRefresh, deriveTokenWrapKey(opts.refreshToken))
    }
    catch (err) {
      console.error('[oauth] failed to unwrap DEK on refresh', row.id, err)
      throw oauthError(400, 'invalid_grant', 'Grant cannot decrypt data — reconnect the connector.')
    }
  }

  const pair = tokenPair(dek)
  await db
    .update(oauthTokens)
    .set({
      accessTokenHash: pair.accessTokenHash,
      refreshTokenHash: pair.refreshTokenHash,
      wrappedDekAccess: pair.wrappedDekAccess,
      wrappedDekRefresh: pair.wrappedDekRefresh,
      accessExpiresAt: pair.accessExpiresAt,
      refreshExpiresAt: pair.refreshExpiresAt,
    })
    .where(eq(oauthTokens.id, row.id))

  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: OAUTH_SCOPE,
  }
}

/* -------------------------------------------------------------------------- */
/*  Access-token validation (called from mcpAuth)                              */
/* -------------------------------------------------------------------------- */

export interface OauthAccessContext {
  userId: number
  dek: Buffer | null
  clientRowId: number
  grantId: number
}

/**
 * Resolve an `nfat_…` access token. Returns null for unknown / revoked /
 * expired tokens so the caller can emit the standard 401 challenge.
 */
export async function resolveOauthAccessToken(token: string): Promise<OauthAccessContext | null> {
  const db = useDb()
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(
      eq(oauthTokens.accessTokenHash, hashOauthSecret(token)),
      isNull(oauthTokens.revokedAt),
    ))
    .limit(1)

  if (!row) return null
  if (row.accessExpiresAt.getTime() < Date.now()) return null

  let dek: Buffer | null = null
  if (row.wrappedDekAccess) {
    try {
      dek = unwrap(row.wrappedDekAccess, deriveTokenWrapKey(token))
    }
    catch (err) {
      console.error('[oauth] failed to unwrap DEK for access token', row.id, err)
      return null
    }
  }

  void db
    .update(oauthTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthTokens.id, row.id))
    .catch(() => { /* bookkeeping only */ })

  return { userId: row.userId, dek, clientRowId: row.clientRowId, grantId: row.id }
}

/**
 * RFC 7009 revocation. Matches the value against both token columns so the
 * caller doesn't have to get `token_type_hint` right; scoped to the
 * authenticated client so one connector can't revoke another's grant.
 */
export async function revokeOauthToken(clientRowId: number, token: string): Promise<void> {
  const db = useDb()
  const hash = hashOauthSecret(token)
  const now = new Date()
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.clientRowId, clientRowId), eq(oauthTokens.accessTokenHash, hash)))
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.clientRowId, clientRowId), eq(oauthTokens.refreshTokenHash, hash)))
}

/** Revoke every grant issued to a client — used when the client is deleted. */
export async function revokeGrantsForClient(clientRowId: number): Promise<void> {
  await useDb()
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.clientRowId, clientRowId), isNull(oauthTokens.revokedAt)))
}
