/**
 * PATCH /api/preferences — partial update of editor/ai/notifications JSON
 * blobs. Each section is deep-merged with the existing row so unspecified
 * keys are preserved (e.g. saving `{ editor: { fontSize: 'large' } }` won't
 * clobber `editor.columnWidth`).
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { userPreferences, type UserPreferences } from '~/server/database/schema'
import { requireUser } from '~/server/utils/require-user'

const EditorSchema = z
  .object({
    columnWidth: z.enum(['narrow', 'normal', 'wide']).optional(),
    fontSize: z.enum(['small', 'normal', 'large']).optional(),
    focusModeDefault: z.boolean().optional(),
  })
  .strict()

const AiSchema = z
  .object({
    chatModel: z.string().trim().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    disableRewriter: z.boolean().optional(),
    disableReranker: z.boolean().optional(),
  })
  .strict()

const NotificationsSchema = z
  .object({
    analysisDone: z.boolean().optional(),
    mentionInDoc: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
  })
  .strict()

const Body = z
  .object({
    editor: EditorSchema.optional(),
    ai: AiSchema.optional(),
    notifications: NotificationsSchema.optional(),
  })
  .strict()

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const input = await readValidatedBody(event, Body.parse)
  const db = useDb()

  // Load current row (or insert defaults) so we can shallow-merge each
  // section without losing unspecified keys.
  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, user.id))
    .limit(1)

  const current: UserPreferences = existing ?? {
    userId: user.id,
    editor: {},
    ai: {},
    notifications: {},
    updatedAt: new Date(),
  }

  const merged = {
    editor: input.editor ? { ...current.editor, ...input.editor } : current.editor,
    ai: input.ai ? { ...current.ai, ...input.ai } : current.ai,
    notifications: input.notifications
      ? { ...current.notifications, ...input.notifications }
      : current.notifications,
    updatedAt: new Date(),
  }

  if (!existing) {
    const [created] = await db
      .insert(userPreferences)
      .values({ userId: user.id, ...merged })
      .returning()
    if (!created) {
      throw createError({ statusCode: 500, statusMessage: 'preferences_insert_failed' })
    }
    return { preferences: created satisfies UserPreferences }
  }

  const [updated] = await db
    .update(userPreferences)
    .set(merged)
    .where(eq(userPreferences.userId, user.id))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 500, statusMessage: 'preferences_update_failed' })
  }

  return { preferences: updated satisfies UserPreferences }
})
