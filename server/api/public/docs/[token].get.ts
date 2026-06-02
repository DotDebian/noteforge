import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, shareTokens, workspaces } from '~/server/database/schema'
import { deriveTokenWrapKey, unwrap } from '~/server/utils/crypto'
import { decryptDocument, decryptWorkspace } from '~/server/utils/encrypted-entities'
import { applyRateLimitByIp } from '~/server/utils/rate-limit'

/**
 * Sprint 5 / F9 — public read-only view of a shared document.
 * Intentionally unauthenticated. Token lookup is constant-time enough as
 * SQLite primary-key lookup; we don't expose a count side-channel either.
 *
 * Encryption: the document columns are ciphertext under the workspace key.
 * The share row stores that key wrapped under a key derived from the raw
 * token; we re-derive it here from the URL token and decrypt. We never store
 * the raw token — only its SHA-256 hash, which is what we look up by.
 *
 * Returned payload is the minimal projection needed to render the read-only
 * page: title, markdown, updatedAt, and the parent workspace's name (for
 * the "Viewing a shared document from <workspaceName>" banner). Everything
 * else — contentJson, folderId, analysis, chunks — is intentionally
 * stripped.
 */
export default defineEventHandler(async (event) => {
  // Rate-limit BEFORE any DB work so a flood costs us nothing per-request.
  applyRateLimitByIp(event, 'public-share')

  const token = getRouterParam(event, 'token')
  if (!token) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const db = useDb()
  const tokenHash = createHash('sha256').update(token).digest('hex')

  const [share] = await db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.token, tokenHash))
    .limit(1)

  if (!share) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (share.revokedAt) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, share.docId))
    .limit(1)

  // Soft-deleted (trashed) docs are not visible publicly even if a share
  // link existed for them. Same 404 to avoid leaking existence.
  if (!doc || doc.deletedAt) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const [ws] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, doc.workspaceId))
    .limit(1)

  // Re-derive the workspace key from the URL token. `null` only for legacy
  // shares minted before encryption — `decrypt*` then passes plaintext
  // through unchanged.
  const key = share.wrappedKey
    ? unwrap(share.wrappedKey, deriveTokenWrapKey(token))
    : null

  const decDoc = decryptDocument({ title: doc.title, markdown: doc.markdown }, key)
  const decWs = decryptWorkspace({ name: ws?.name ?? '' }, key)

  return {
    document: {
      title: decDoc.title,
      markdown: decDoc.markdown,
      updatedAt: doc.updatedAt,
    },
    workspaceName: decWs.name,
  }
})
