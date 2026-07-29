import { defineEventHandler, getMethod, setResponseStatus } from 'h3'
import { OAUTH_SCOPE, publicOrigin, setOauthCors } from '~/server/utils/oauth'

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 *
 * Deliberately absent: `registration_endpoint`. We do NOT support dynamic
 * client registration — connectors are minted from the NoteForge UI and the
 * user pastes the id/secret into Claude's advanced connector settings. Not
 * advertising it is what makes Claude ask for those fields instead of trying
 * (and failing) to self-register.
 *
 * `authorization_endpoint` is a Nuxt *page*, not an API route: it renders the
 * consent screen, reusing the normal session cookie (and bouncing through
 * `/login?redirect=…` when the user isn't signed in).
 */
export default defineEventHandler((event) => {
  setOauthCors(event)
  if (getMethod(event) === 'OPTIONS') {
    setResponseStatus(event, 204)
    return null
  }

  const origin = publicOrigin(event)
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    // S256 only — `plain` is rejected at the authorize endpoint.
    code_challenge_methods_supported: ['S256'],
  }
})
