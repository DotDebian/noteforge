import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses } from '~/server/database/schema'
import { assertDocumentAccess, parseIdParam } from '~/server/utils/access'

const Body = z.object({
  actionItems: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(500),
        done: z.boolean(),
      }),
    )
    .max(50),
})

export default defineEventHandler(async (event) => {
  const docId = parseIdParam(event, 'docId')
  await assertDocumentAccess(event, docId)
  const { actionItems } = await readValidatedBody(event, Body.parse)

  const db = useDb()
  const [existing] = await db
    .select({ docId: docAnalyses.docId })
    .from(docAnalyses)
    .where(eq(docAnalyses.docId, docId))
    .limit(1)

  if (!existing) {
    throw createError({
      statusCode: 404,
      statusMessage: 'No analysis found for this document. Run analysis first.',
    })
  }

  const [updated] = await db
    .update(docAnalyses)
    .set({ actionItems })
    .where(eq(docAnalyses.docId, docId))
    .returning({ actionItems: docAnalyses.actionItems })

  return { actionItems: updated?.actionItems ?? actionItems }
})
