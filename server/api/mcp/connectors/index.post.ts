import { z } from 'zod'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { oauthClients } from '~/server/database/schema'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'
import {
  DEFAULT_REDIRECT_URIS,
  generateClientId,
  generateClientSecret,
  hashOauthSecret,
  secretPrefix,
} from '~/server/utils/oauth'

/**
 * Register a new OAuth connector. Returns `clientSecret` in clear ONCE —
 * only its SHA-256 digest is persisted.
 *
 * `redirectUris` defaults to Claude's two custom-connector callbacks. A caller
 * can pass extra ones (a self-hosted MCP client, say); loopback URLs never
 * need registering, `isRedirectUriAllowed` accepts them by policy.
 *
 * The DEK check mirrors token creation: it isn't needed to *create* the client
 * (the DEK is captured later, at consent time), but failing here — while the
 * user is looking at the dialog — beats failing mid-OAuth-redirect inside
 * Claude, where the error is far less legible.
 */
const Body = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    redirectUris: z.array(z.string().url()).max(10).optional(),
  })
  .default({})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  if (!dek) {
    throw createError({
      statusCode: 412,
      statusMessage: 'session_missing_dek',
      data: { detail: 'Log out and back in to refresh your session, then create the connector.' },
    })
  }

  const input = await readValidatedBody(event, Body.parse)

  const clientId = generateClientId()
  const clientSecret = generateClientSecret()
  const redirectUris = Array.from(
    new Set([...DEFAULT_REDIRECT_URIS, ...(input.redirectUris ?? [])]),
  )

  const db = useDb()
  const [created] = await db
    .insert(oauthClients)
    .values({
      userId: user.id,
      name: input.name ?? null,
      clientId,
      clientSecretHash: hashOauthSecret(clientSecret),
      secretPrefix: secretPrefix(clientSecret),
      redirectUris,
    })
    .returning({
      id: oauthClients.id,
      name: oauthClients.name,
      clientId: oauthClients.clientId,
      secretPrefix: oauthClients.secretPrefix,
      lastUsedAt: oauthClients.lastUsedAt,
      createdAt: oauthClients.createdAt,
    })

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create connector' })
  }

  return { clientSecret, connector: created }
})
