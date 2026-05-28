/**
 * GET /api/ai/chat/sessions/:id/export
 *
 * Wave 4 / N10 — markdown export of a single chat session. Returns the full
 * conversation rendered as `text/markdown` with a `Content-Disposition:
 * attachment` header so the browser triggers a download.
 *
 * Same decryption pattern as `sessions/[id].get.ts`: everything funnels through
 * the per-user DEK so the file written to the user's disk is plaintext.
 */
import { asc, eq } from 'drizzle-orm'
import { createError, defineEventHandler, setHeader } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { decryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import {
  decryptChatMessageContent,
  decryptChatSources,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'

function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  return ''
}

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

  const title = decryptField(session.title, dek) || 'Untitled chat'
  const startedAt = formatDate(session.createdAt)

  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  if (startedAt) {
    lines.push(`_Started ${startedAt}_`)
    lines.push('')
  }

  for (const m of messages) {
    const content = decryptChatMessageContent(m.content, dek)
    const sources = decryptChatSources(m.sources, dek)

    if (m.role === 'user') {
      lines.push('## You')
    }
    else if (m.role === 'assistant') {
      lines.push('## Assistant')
    }
    else {
      lines.push(`## ${m.role}`)
    }
    lines.push('')
    lines.push(content.trim() || '_(empty)_')
    lines.push('')

    if (sources.length > 0) {
      const refs = sources.map((s) => {
        if (s.kind === 'web' && s.url) {
          const t = s.title?.trim() || s.url
          return `[${t}](${s.url})`
        }
        const t = s.title?.trim() || `Doc ${s.docId}`
        return `[${t}](note id ${s.docId})`
      })
      lines.push(`_Sources: ${refs.join(', ')}_`)
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  const body = lines.join('\n')
  const safeFilename = `chat-${id}.md`

  setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="${safeFilename}"`)
  setHeader(event, 'Cache-Control', 'private, no-store')

  return body
})
