import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { useDb } from '~/server/database/client'
import { chatSessions } from '~/server/database/schema'
import { assertDocumentAccess, assertWorkspaceAccess } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import { requireUser } from '~/server/utils/require-user'

const Query = z.object({
  workspaceId: z.coerce.number().int().positive(),
  // When set, return sessions pinned to that document. Otherwise return
  // workspace-level sessions (scopeDocId IS NULL AND scopeFolderId IS NULL).
  docId: z.coerce.number().int().positive().optional(),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { workspaceId, docId } = await getValidatedQuery(event, Query.parse)
  await assertWorkspaceAccess(event, workspaceId)
  const dek = await getDek(event)

  const db = useDb()
  const decryptTitles = <T extends { title: string }>(rows: T[]): T[] =>
    rows.map(r => ({ ...r, title: decryptField(r.title, dek) }))

  if (docId != null) {
    const doc = await assertDocumentAccess(event, docId)
    if (doc.workspaceId !== workspaceId) {
      // Mismatched workspace/doc — return nothing rather than leaking.
      return []
    }
    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(
        eq(chatSessions.userId, user.id),
        eq(chatSessions.workspaceId, workspaceId),
        eq(chatSessions.scopeDocId, docId),
      ))
      .orderBy(desc(chatSessions.createdAt), desc(chatSessions.id))
    return decryptTitles(rows)
  }

  // Workspace-level: hide scoped sessions (both doc- and folder-scoped) so
  // they don't pollute the workspace history list.
  const rows = await db
    .select()
    .from(chatSessions)
    .where(and(
      eq(chatSessions.userId, user.id),
      eq(chatSessions.workspaceId, workspaceId),
      isNull(chatSessions.scopeDocId),
      isNull(chatSessions.scopeFolderId),
    ))
    .orderBy(desc(chatSessions.createdAt), desc(chatSessions.id))

  return decryptTitles(rows)
})
