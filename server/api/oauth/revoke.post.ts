import { defineEventHandler, getMethod, getRequestHeader, readBody, setHeader, setResponseStatus } from 'h3'
import {
  findOauthClient,
  oauthError,
  revokeOauthToken,
  setOauthCors,
  verifyClientSecret,
} from '~/server/utils/oauth'

/**
 * RFC 7009 token revocation. Advertised in the AS metadata, so Claude calls it
 * when the user removes the connector on their side.
 *
 * Per §2.2 the response is 200 even for an unknown token — telling a caller
 * "that token doesn't exist" would be an oracle. Only client authentication
 * failures produce an error.
 */
export default defineEventHandler(async (event) => {
  setOauthCors(event)
  if (getMethod(event) === 'OPTIONS') {
    setResponseStatus(event, 204)
    return null
  }
  setHeader(event, 'cache-control', 'no-store')

  const raw = await readBody<Record<string, unknown> | undefined>(event)
  const body = raw && typeof raw === 'object' ? raw : {}

  let clientId: string | undefined
  let clientSecret: string | undefined
  const header = getRequestHeader(event, 'authorization')
  if (header && header.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    if (sep !== -1) {
      clientId = decodeURIComponent(decoded.slice(0, sep))
      clientSecret = decodeURIComponent(decoded.slice(sep + 1))
    }
  }
  else {
    if (typeof body.client_id === 'string') clientId = body.client_id
    if (typeof body.client_secret === 'string') clientSecret = body.client_secret
  }

  if (!clientId || !clientSecret) {
    throw oauthError(401, 'invalid_client', 'Client authentication is required.')
  }
  const client = await findOauthClient(clientId)
  if (!client || !verifyClientSecret(client, clientSecret)) {
    throw oauthError(401, 'invalid_client', 'Client authentication failed.')
  }

  const token = typeof body.token === 'string' ? body.token : null
  if (token) await revokeOauthToken(client.id, token)

  setResponseStatus(event, 200)
  return {}
})
