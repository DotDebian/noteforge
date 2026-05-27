import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { defineEventHandler, createError, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { documents } from '~/server/database/schema'
import { requireAdmin } from '~/server/utils/require-admin'
import { embedDocument } from '~/server/utils/embed-doc'

const Body = z.object({
  docId: z.number().int().positive(),
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { docId } = await readValidatedBody(event, Body.parse)

  const db = useDb()
  const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1)
  if (!doc) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }

  const count = await embedDocument(docId, doc.markdown)

  return { docId, chunksIndexed: count }
})
