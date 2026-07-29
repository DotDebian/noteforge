import type { H3Event } from 'h3'
import { defineEventHandler, getMethod, getRequestHeader, readBody, setHeader, setResponseStatus } from 'h3'
import {
  exchangeAuthorizationCode,
  findOauthClient,
  oauthError,
  refreshOauthGrant,
  setOauthCors,
  verifyClientSecret,
} from '~/server/utils/oauth'

/**
 * RFC 6749 token endpoint. Handles `authorization_code` (with PKCE) and
 * `refresh_token`.
 *
 * Bodies arrive as `application/x-www-form-urlencoded` from every real client;
 * `readBody` parses that into a plain object, and also copes with the JSON
 * some tooling sends instead. We read loosely and validate by grant type
 * rather than up front, because the required fields differ per grant.
 */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Resolve client credentials from either supported auth method:
 * `client_secret_basic` (Authorization header) or `client_secret_post` (body).
 * The header wins when both are present, per RFC 6749 §2.3.1.
 */
function readClientCredentials(
  event: H3Event,
  body: Record<string, unknown>,
): { clientId: string, clientSecret: string } {
  const header = getRequestHeader(event, 'authorization')
  if (header && header.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    if (sep === -1) {
      throw oauthError(401, 'invalid_client', 'Malformed Basic authorization header.')
    }
    return {
      // Both halves are form-encoded inside Basic auth (RFC 6749 §2.3.1).
      clientId: decodeURIComponent(decoded.slice(0, sep)),
      clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
    }
  }

  const clientId = str(body.client_id)
  const clientSecret = str(body.client_secret)
  if (!clientId || !clientSecret) {
    throw oauthError(401, 'invalid_client', 'Client authentication is required (client_id + client_secret).')
  }
  return { clientId, clientSecret }
}

export default defineEventHandler(async (event) => {
  setOauthCors(event)
  if (getMethod(event) === 'OPTIONS') {
    setResponseStatus(event, 204)
    return null
  }

  // Tokens must never land in a shared cache.
  setHeader(event, 'cache-control', 'no-store')
  setHeader(event, 'pragma', 'no-cache')

  const raw = await readBody<Record<string, unknown> | undefined>(event)
  const body = raw && typeof raw === 'object' ? raw : {}

  const { clientId, clientSecret } = readClientCredentials(event, body)
  const client = await findOauthClient(clientId)
  if (!client || !verifyClientSecret(client, clientSecret)) {
    // Same error for unknown id and wrong secret — no client enumeration.
    throw oauthError(401, 'invalid_client', 'Client authentication failed.')
  }

  const grantType = str(body.grant_type)

  if (grantType === 'authorization_code') {
    const code = str(body.code)
    const redirectUri = str(body.redirect_uri)
    const codeVerifier = str(body.code_verifier)
    if (!code) throw oauthError(400, 'invalid_request', 'Missing code.')
    if (!redirectUri) throw oauthError(400, 'invalid_request', 'Missing redirect_uri.')
    if (!codeVerifier) throw oauthError(400, 'invalid_request', 'Missing code_verifier (PKCE is required).')

    const issued = await exchangeAuthorizationCode({ client, code, redirectUri, codeVerifier })
    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    }
  }

  if (grantType === 'refresh_token') {
    const refreshToken = str(body.refresh_token)
    if (!refreshToken) throw oauthError(400, 'invalid_request', 'Missing refresh_token.')

    const issued = await refreshOauthGrant({ client, refreshToken })
    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    }
  }

  throw oauthError(
    400,
    'unsupported_grant_type',
    'Only authorization_code and refresh_token are supported.',
  )
})
