/**
 * PATCH /api/ai/chat/sessions/:id/messages/:msgId
 *
 * Body: `{ content: string }`.
 *
 * Updates the content of a single chat message — used by the "edit user
 * message before re-sending" flow. The caller is expected to follow up with
 * a DELETE on every later message and a fresh chat completion request.
 *
 * Authz: the session must belong to the current user, and the message must
 * live in that session.
 */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { createError, defineEventHandler, getRouterParam, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import {
  decryptChatMessageContent,
  decryptChatSources,
  encryptChatMessageContent,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  content: z.string().trim().min(1).max(8000),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const sessionId = parseIdParam(event)

  const rawMsg = getRouterParam(event, 'msgId')
  const msgId = Number(rawMsg)
  if (!rawMsg || !Number.isInteger(msgId) || msgId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid msgId' })
  }

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

  const [existing] = await db
    .select()
    .from(chatMessages)
    .where(and(
      eq(chatMessages.id, msgId),
      eq(chatMessages.sessionId, sessionId),
    ))
    .limit(1)

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Message not found' })
  }

  const [updated] = await db
    .update(chatMessages)
    .set({ content: encryptChatMessageContent(body.content, dek) })
    .where(eq(chatMessages.id, msgId))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to update message' })
  }

  return {
    message: {
      ...updated,
      content: decryptChatMessageContent(updated.content, dek),
      sources: decryptChatSources(updated.sources, dek),
    },
  }
})
