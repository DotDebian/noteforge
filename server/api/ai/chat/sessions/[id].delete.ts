import { eq } from 'drizzle-orm'
import { createError, defineEventHandler } from 'h3'
import { useDb } from '~/server/database/client'
import { chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { requireUser } from '~/server/utils/require-user'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
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

  // chat_messages has ON DELETE CASCADE on session_id, so a single delete
  // is enough.
  await db.delete(chatSessions).where(eq(chatSessions.id, id))
  return { ok: true }
})
