import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { useDb } from '~/server/database/client'
import { chatSessions, type ChatSession } from '~/server/database/schema'
import { assertDocumentAccess, assertWorkspaceAccess } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
  // When set, return sessions pinned to that document. Otherwise return
  // workspace-level sessions (scopeDocId IS NULL AND scopeFolderId IS NULL).
  docId: z.coerce.number().int().positive().optional(),
  /** Optional case-insensitive substring filter on the (decrypted) title. */
  q: z.string().trim().min(1).max(200).optional(),
  /** Page size. Encrypted titles can't be filtered in SQL, so we cap server-side. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Pagination offset over the post-filter, post-decrypt window. */
  offset: z.coerce.number().int().min(0).optional(),
})

const DEFAULT_LIMIT = 50

/**
 * Wave 4 / I8 — paginated, searchable session list.
 *
 * Encrypted titles can't be filtered or paged with SQL (every encryption uses
 * a fresh IV → different ciphertext for the same plaintext). We therefore:
 *   - load a generous window (limit + offset + 50) ordered by createdAt DESC
 *   - decrypt the titles in JS
 *   - case-insensitive substring-match on `q` if provided
 *   - slice [offset, offset + limit]
 *   - return `{ sessions, hasMore }`
 *
 * For workspaces with thousands of sessions this scans more than strictly
 * necessary; in practice a single user rarely exceeds a few hundred sessions
 * per workspace, so the cost is acceptable. If that ever becomes a bottleneck
 * we'd need to switch to a deterministic per-user title HMAC for searchability.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { workspaceId, docId, q, limit, offset } = await getValidatedQuery(event, Query.parse)
  await assertWorkspaceAccess(event, workspaceId)
  const dek = await getDek(event)

  const pageLimit = limit ?? DEFAULT_LIMIT
  const pageOffset = offset ?? 0
  // Over-fetch slightly so we can compute a reliable `hasMore` after the
  // post-decrypt filter trims rows.
  const fetchCount = pageLimit + pageOffset + 50

  const db = useDb()

  let rows: ChatSession[]
  if (docId != null) {
    const doc = await assertDocumentAccess(event, docId)
    if (doc.workspaceId !== workspaceId) {
      return { sessions: [], hasMore: false }
    }
    rows = await db
      .select()
      .from(chatSessions)
      .where(and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.workspaceId, workspaceId),
        eq(chatSessions.scopeDocId, docId),
      ))
      .orderBy(desc(chatSessions.createdAt), desc(chatSessions.id))
      .limit(fetchCount)
  }
  else {
    rows = await db
      .select()
      .from(chatSessions)
      .where(and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.workspaceId, workspaceId),
        isNull(chatSessions.scopeDocId),
        isNull(chatSessions.scopeFolderId),
      ))
      .orderBy(desc(chatSessions.createdAt), desc(chatSessions.id))
      .limit(fetchCount)
  }

  const decrypted = rows.map(r => ({ ...r, title: decryptField(r.title, dek) }))

  const needle = q?.toLowerCase()
  const filtered = needle
    ? decrypted.filter(s => s.title.toLowerCase().includes(needle))
    : decrypted

  const page = filtered.slice(pageOffset, pageOffset + pageLimit)
  const hasMore = filtered.length > pageOffset + pageLimit

  return { sessions: page, hasMore }
})
