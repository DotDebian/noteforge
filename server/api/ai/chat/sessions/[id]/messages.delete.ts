/**
 * DELETE /api/ai/chat/sessions/:id/messages
 *
 * Body: `{ fromMessageId: number }`.
 *
 * Deletes the chat message with id `fromMessageId` and EVERY later message
 * in the same session (id-monotonic ordering matches the message timeline).
 * Used by the regenerate / edit-user-message flow so we can drop the stale
 * assistant reply (and the user prompt itself when needed) before re-streaming.
 *
 * Authz: the session must belong to the current user.
 */
import { z } from 'zod'
import { and, eq, gte } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  fromMessageId: z.number().int().positive(),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const sessionId = parseIdParam(event)
  const body = await readValidatedBody(event, Body.parse)

  const db = useDb()
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1)

  if (!session) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  if (session.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  // Make sure the anchor message actually lives in this session — guards
  // against cross-session id leakage.
  const [anchor] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.id, body.fromMessageId),
      eq(chatMessages.sessionId, sessionId),
    ))
    .limit(1)

  if (!anchor) {
    throw createError({ statusCode: 404, statusMessage: 'Message not found' })
  }

  await db
    .delete(chatMessages)
    .where(and(
      eq(chatMessages.sessionId, sessionId),
      gte(chatMessages.id, body.fromMessageId),
    ))

  return { ok: true }
})
