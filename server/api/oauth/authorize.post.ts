import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'
import {
  findOauthClient,
  isRedirectUriAllowed,
  issueAuthorizationCode,
  oauthError,
} from '~/server/utils/oauth'

/**
 * Consent submission. Called by `pages/oauth/authorize.vue` once the signed-in
 * user approves; mints the authorization code and hands back the URL the page
 * should navigate to.
 *
 * The DEK is lifted from the session HERE and nowhere else — this is the only
 * moment in the OAuth flow where a browser session exists. It gets wrapped
 * into the code and then rides the token chain, which is what lets an MCP call
 * authenticated by a bare access token decrypt the user's notes.
 */
const Body = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  codeChallenge: z.string().min(1),
  codeChallengeMethod: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  if (!dek) {
    // Same guard as minting a bearer token: a grant that can't decrypt would
    // silently hand ciphertext to Claude.
    throw oauthError(
      412,
      'session_missing_dek',
      'Log out and back in to refresh your session, then authorize the connector.',
    )
  }

  const input = await readValidatedBody(event, Body.parse)

  const client = await findOauthClient(input.clientId)
  if (!client) throw oauthError(400, 'invalid_client', 'Unknown or revoked client_id.')
  if (!isRedirectUriAllowed(client, input.redirectUri)) {
    throw oauthError(400, 'invalid_request', 'redirect_uri is not registered for this connector.')
  }
  if ((input.codeChallengeMethod ?? 'plain') !== 'S256') {
    throw oauthError(400, 'invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  }
  // Connectors are personal: only the owner can grant one access to notes.
  if (client.userId !== user.id) {
    throw oauthError(403, 'access_denied', 'This connector belongs to another account.')
  }

  const code = await issueAuthorizationCode({
    client,
    userId: user.id,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource ?? null,
    dek,
  })

  const target = new URL(input.redirectUri)
  target.searchParams.set('code', code)
  if (input.state) target.searchParams.set('state', input.state)

  return { redirectTo: target.toString() }
})
