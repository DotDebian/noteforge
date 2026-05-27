import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { userQuotas, users } from '~/server/database/schema'
import { requireAdmin } from '~/server/utils/require-admin'
import { parseIdParam } from '~/server/utils/access'
import { logAdminAction } from '~/server/utils/audit'

const Body = z.object({
  maxDocs: z.number().int().nullable().optional(),
  maxTokensMonth: z.number().int().nullable().optional(),
  maxWorkspaces: z.number().int().nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const targetId = parseIdParam(event)
  const input = await readValidatedBody(event, Body.parse)

  const db = useDb()
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const values = {
    userId: targetId,
    maxDocs: input.maxDocs ?? null,
    maxTokensMonth: input.maxTokensMonth ?? null,
    maxWorkspaces: input.maxWorkspaces ?? null,
    updatedAt: new Date(),
  }

  const [row] = await db
    .insert(userQuotas)
    .values(values)
    .onConflictDoUpdate({
      target: userQuotas.userId,
      set: {
        maxDocs: values.maxDocs,
        maxTokensMonth: values.maxTokensMonth,
        maxWorkspaces: values.maxWorkspaces,
        updatedAt: values.updatedAt,
      },
    })
    .returning()

  logAdminAction({
    adminId: admin.id,
    action: 'user.quotas_update',
    targetType: 'user',
    targetId,
    payload: {
      maxDocs: values.maxDocs,
      maxTokensMonth: values.maxTokensMonth,
      maxWorkspaces: values.maxWorkspaces,
    },
  })

  return {
    quotas: row
      ? {
          maxDocs: row.maxDocs,
          maxTokensMonth: row.maxTokensMonth,
          maxWorkspaces: row.maxWorkspaces,
        }
      : {
          maxDocs: values.maxDocs,
          maxTokensMonth: values.maxTokensMonth,
          maxWorkspaces: values.maxWorkspaces,
        },
  }
})
