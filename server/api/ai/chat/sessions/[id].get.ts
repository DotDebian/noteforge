import { asc, eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import {
  decryptChatFollowups,
  decryptChatMessageContent,
  decryptChatMeta,
  decryptChatSources,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const id = parseIdParam(event)

  const db = useDb()
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1)

  if (!session) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  if (session.userId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, id))
    .orderBy(asc(chatMessages.id))

  return {
    session: { ...session, title: decryptField(session.title, dek) },
    messages: messages.map(m => ({
      ...m,
      content: decryptChatMessageContent(m.content, dek),
      sources: decryptChatSources(m.sources, dek),
      followups: decryptChatFollowups(m.followups, dek),
      meta: decryptChatMeta(m.meta, dek),
    })),
  }
})
