import { z } from 'zod'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { findOauthClient, isRedirectUriAllowed, OAUTH_SCOPE, oauthError } from '~/server/utils/oauth'

/**
 * Validation half of the authorization endpoint, consumed by the consent page
 * (`pages/oauth/authorize.vue`) before it renders anything.
 *
 * Intentionally unauthenticated: the page needs to name the connector even
 * when the visitor still has to sign in, and everything returned here is
 * already known to whoever holds the client id.
 *
 * Split of responsibility with RFC 6749 §4.1.2.1: errors about *who is asking*
 * (unknown client, bad redirect_uri) must NOT be redirected back — they'd be
 * an open redirect. They surface as a 400 rendered on our own page. Errors
 * about *what was asked* are the caller's fault and can be bounced back, which
 * `pages/oauth/authorize.vue` does using the `redirectUri` we echo here.
 */
const Query = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, Query.parse)

  const client = await findOauthClient(q.client_id)
  if (!client) {
    throw oauthError(400, 'invalid_client', 'Unknown or revoked client_id.')
  }
  if (!isRedirectUriAllowed(client, q.redirect_uri)) {
    throw oauthError(400, 'invalid_request', 'redirect_uri is not registered for this connector.')
  }
  if (q.response_type !== 'code') {
    throw oauthError(400, 'unsupported_response_type', 'Only the authorization code flow is supported.')
  }
  if ((q.code_challenge_method ?? 'plain') !== 'S256') {
    throw oauthError(400, 'invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  }

  return {
    client: {
      name: client.name,
      clientId: client.clientId,
    },
    redirectUri: q.redirect_uri,
    state: q.state ?? null,
    scope: OAUTH_SCOPE,
  }
})
