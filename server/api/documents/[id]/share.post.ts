import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { shareTokens } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { deriveTokenWrapKey, wrap } from '~/server/utils/crypto'
import { requireUser } from '~/server/utils/require-user'
import { getWorkspaceKey } from '~/server/utils/workspace-key'

const Body = z.object({
  expiresInDays: z.number().int().positive().max(3650).optional(),
})

/**
 * Create a public read-only share token for a document (Sprint 5 / F9).
 * Returns the token + relative URL. The caller is responsible for owning
 * the document (enforced by `assertDocumentAccess`).
 *
 * Encryption: the document is stored as ciphertext under the workspace key
 * (DEK / WEK). The public reader has no session, so we wrap that key under a
 * key derived from the raw token (`deriveTokenWrapKey`) and persist only the
 * SHA-256 hash of the token. The raw token lives solely in the returned URL —
 * a stolen DB holds neither the token nor a usable key. The clear token is
 * therefore shown exactly once, at creation.
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  const doc = await assertDocumentAccess(event, id)
  const key = await getWorkspaceKey(event, doc.workspaceId)

  // POST bodies are optional — readValidatedBody returns {} for empty bodies
  // which still passes the schema (all fields optional).
  const input = await readValidatedBody(event, (raw) => Body.parse(raw ?? {}))

  // 24 random bytes → 32 base64url chars. Comfortable beyond brute-force
  // even without rate limiting; with the 30 req/min IP limit the search
  // space is unreachable.
  const token = randomBytes(24).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')

  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null

  const db = useDb()
  await db.insert(shareTokens).values({
    token: tokenHash,
    prefix: token.slice(0, 8),
    docId: id,
    createdBy: user.id,
    expiresAt,
    // `null` when the workspace predates encryption — the reader then treats
    // the (plaintext) columns as pass-through.
    wrappedKey: key ? wrap(key, deriveTokenWrapKey(token)) : null,
  })

  return { token, url: `/share/${token}` }
})
