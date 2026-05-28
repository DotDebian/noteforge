/**
 * POST /api/ai/chat/messages/:id/feedback
 *
 * Body: `{ feedback: -1 | 0 | 1 }` — 0 clears, ±1 sets thumbs down/up.
 *
 * Records the user's thumbs up/down rating on an assistant chat message
 * (Wave 2 / N3). Used by the per-message feedback chip below assistant
 * replies. Ownership is verified by walking from the message → its session
 * → owner.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

const Body = z.object({
  feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const messageId = parseIdParam(event)
  const { feedback } = await readValidatedBody(event, Body.parse)

  const db = useDb()

  const [msg] = await db
    .select({ id: chatMessages.id, sessionId: chatMessages.sessionId })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1)

  if (!msg) throw createError({ statusCode: 404, statusMessage: 'Message not found' })

  const [session] = await db
    .select({ userId: chatSessions.userId })
    .from(chatSessions)
    .where(eq(chatSessions.id, msg.sessionId))
    .limit(1)

  if (!session) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  if (session.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  await db
    .update(chatMessages)
    .set({ userFeedback: feedback === 0 ? null : feedback })
    .where(eq(chatMessages.id, messageId))

  return { ok: true as const }
})
