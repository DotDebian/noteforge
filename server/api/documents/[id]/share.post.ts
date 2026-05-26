import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { shareTokens } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  expiresInDays: z.number().int().positive().max(3650).optional(),
})

/**
 * Create a public read-only share token for a document (Sprint 5 / F9).
 * Returns the token + relative URL. The caller is responsible for owning
 * the document (enforced by `assertDocumentAccess`).
 */
export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const user = await requireUser(event)
  await assertDocumentAccess(event, id)

  // POST bodies are optional — readValidatedBody returns {} for empty bodies
  // which still passes the schema (all fields optional).
  const input = await readValidatedBody(event, (raw) => Body.parse(raw ?? {}))

  // 24 random bytes → 32 base64url chars. Comfortable beyond brute-force
  // even without rate limiting; with the 30 req/min IP limit the search
  // space is unreachable.
  const token = randomBytes(24).toString('base64url')

  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null

  const db = useDb()
  await db.insert(shareTokens).values({
    token,
    docId: id,
    createdBy: user.id,
    expiresAt,
  })

  return { token, url: `/share/${token}` }
})
