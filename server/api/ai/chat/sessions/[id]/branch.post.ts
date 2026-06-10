/**
 * POST /api/ai/chat/sessions/:id/branch
 *
 * Body: `{ messageId: number, title?: string }`.
 *
 * Forks an existing chat session at `messageId` (inclusive — every message
 * with `id <= messageId` is copied into the new branch, preserving order).
 * The new session keeps the same workspace + scope (folder / doc) as the
 * source and stores `parentSessionId` + `branchFromMessageId` so the UI can
 * surface the lineage.
 *
 * Authz: the source session must belong to the current user, and the
 * workspace must still be accessible.
 */
import { z } from 'zod'
import { and, asc, eq, lte } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { assertWorkspaceOwnership, parseIdParam } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import {
  decryptChatFollowups,
  decryptChatMessageContent,
  decryptChatMeta,
  decryptChatSources,
  encryptChatSessionTitle,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  messageId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
})

const TITLE_CAP = 80

function capTitle(raw: string): string {
  const t = raw.trim()
  if (t.length <= TITLE_CAP) return t
  // Strip a trailing ellipsis we'll be re-adding ourselves.
  return `${t.slice(0, TITLE_CAP - 1).trimEnd()}…`
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const sourceId = parseIdParam(event)
  const body = await readValidatedBody(event, Body.parse)

  const db = useDb()

  const [source] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sourceId))
    .limit(1)

  if (!source) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  if (source.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  // Verify the workspace is still accessible (could have been deleted
  // separately even though the session row survives).
  await assertWorkspaceOwnership(user.id, source.workspaceId)

  // The anchor message must live in the source session.
  const [anchor] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.id, body.messageId),
      eq(chatMessages.sessionId, sourceId),
    ))
    .limit(1)

  if (!anchor) {
    throw createError({ statusCode: 400, statusMessage: 'Message does not belong to this session' })
  }

  // Pull every message up to AND INCLUDING the anchor, in chronological order.
  const sourceMessages = await db
    .select()
    .from(chatMessages)
    .where(and(
      eq(chatMessages.sessionId, sourceId),
      lte(chatMessages.id, body.messageId),
    ))
    .orderBy(asc(chatMessages.id))

  if (sourceMessages.length === 0) {
    // Defensive: anchor lookup passed above, so this should be unreachable.
    throw createError({ statusCode: 500, statusMessage: 'No messages to branch' })
  }

  const sourceTitlePlain = decryptField(source.title, dek)
  const newTitlePlain = capTitle(body.title ?? `↪ ${sourceTitlePlain}`)

  // Create the branch session.
  const [branched] = await db
    .insert(chatSessions)
    .values({
      userId: source.userId,
      workspaceId: source.workspaceId,
      scopeFolderId: source.scopeFolderId,
      scopeDocId: source.scopeDocId,
      title: encryptChatSessionTitle(newTitlePlain, dek),
      parentSessionId: source.id,
      branchFromMessageId: body.messageId,
    })
    .returning()

  if (!branched) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create branch session' })
  }

  // Bulk-insert the copied messages. Ordering is preserved via insertion
  // order — autoincrement ids monotonically grow as we insert.
  const rows = sourceMessages.map(m => ({
    sessionId: branched.id,
    role: m.role,
    content: m.content,
    sources: m.sources,
    // Copy ciphertext verbatim so branched turns keep their follow-ups + meta.
    followups: m.followups,
    meta: m.meta,
  }))

  const inserted = await db
    .insert(chatMessages)
    .values(rows)
    .returning()

  return {
    session: { ...branched, title: newTitlePlain },
    messages: inserted.map(m => ({
      ...m,
      content: decryptChatMessageContent(m.content, dek),
      sources: decryptChatSources(m.sources, dek),
      followups: decryptChatFollowups(m.followups, dek),
      meta: decryptChatMeta(m.meta, dek),
    })),
  }
})
