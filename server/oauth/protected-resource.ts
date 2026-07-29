import { defineEventHandler, getMethod, setResponseStatus } from 'h3'
import { mcpResourceUrl, OAUTH_SCOPE, publicOrigin, setOauthCors } from '~/server/utils/oauth'

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * This is the entry point of the whole custom-connector dance: Claude hits
 * `/api/mcp` unauthenticated, gets a 401 whose `WWW-Authenticate` header
 * points here, then follows `authorization_servers` to our AS metadata.
 *
 * Registered (see `nitro.handlers` in nuxt.config.ts) at BOTH
 * `/.well-known/oauth-protected-resource` and the path-inserted form
 * `/.well-known/oauth-protected-resource/api/mcp` — clients differ on which
 * one they try, and serving the same document from both costs nothing.
 */
export default defineEventHandler((event) => {
  setOauthCors(event)
  if (getMethod(event) === 'OPTIONS') {
    setResponseStatus(event, 204)
    return null
  }

  return {
    resource: mcpResourceUrl(event),
    authorization_servers: [publicOrigin(event)],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: `${publicOrigin(event)}/`,
  }
})
