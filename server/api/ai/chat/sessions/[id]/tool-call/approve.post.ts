/**
 * POST /api/ai/chat/sessions/:id/tool-call/approve
 *
 * Wave 4 / N8 — second half of the agentic tool-call flow. The chat endpoint
 * emits a `tool_call_pending` SSE frame with the model's proposed actions;
 * the client renders an approve/reject card; the user's decision lands here.
 *
 * Body:
 *   {
 *     accept: boolean,
 *     toolCall: { name: 'create_note' | 'update_note' | 'delete_note', arguments: object }
 *   }
 *
 * On approve we execute the requested mutation through `notes.ts` (which
 * already enforces ownership via `assert*Ownership` against the bearer
 * userId), then persist an assistant follow-up message describing what
 * happened. On reject we just persist a short "rejected" note and return.
 *
 * The model NEVER touches the DB directly — every mutation goes through the
 * shared service layer with the authenticated user's id and DEK so the
 * encryption + access invariants are preserved.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { chatMessages, chatSessions } from '~/server/database/schema'
import { parseIdParam } from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import { encryptChatMessageContent } from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'
import {
  createUserDocument,
  softDeleteUserDocument,
  updateUserDocument,
} from '~/server/utils/notes'

/** Tool-call argument schemas — match the wire descriptors in chat.post.ts. */
const CreateNoteArgs = z.object({
  workspaceId: z.number().int().positive(),
  folderId: z.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(300),
  markdown: z.string().min(0).max(200_000),
})

const UpdateNoteArgs = z.object({
  documentId: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  markdown: z.string().min(0).max(200_000).optional(),
})

const DeleteNoteArgs = z.object({
  documentId: z.number().int().positive(),
})

const Body = z.object({
  accept: z.boolean(),
  toolCall: z.object({
    name: z.enum(['create_note', 'update_note', 'delete_note']),
    // The model emits arguments as a JSON object; we re-validate per-tool below.
    arguments: z.record(z.unknown()),
  }),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const sessionId = parseIdParam(event)
  const { accept, toolCall } = await readValidatedBody(event, Body.parse)

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

  // Build the follow-up assistant message. Either path persists exactly one
  // message describing the outcome.
  let followup: string

  if (!accept) {
    followup = `Action rejected — \`${toolCall.name}\` was not executed.`
  }
  else {
    try {
      if (toolCall.name === 'create_note') {
        const args = CreateNoteArgs.parse(toolCall.arguments)
        // Force the workspace to the session's workspace — the model can ask
        // for any workspace id but only the session's is in-scope.
        const doc = await createUserDocument(user.id, {
          workspaceId: session.workspaceId,
          folderId: args.folderId ?? null,
          title: args.title,
          markdown: args.markdown,
        }, dek)
        followup = `Created note **${doc.title}** (id ${doc.id}).`
      }
      else if (toolCall.name === 'update_note') {
        const args = UpdateNoteArgs.parse(toolCall.arguments)
        // `updateUserDocument` calls `assertDocumentOwnership` which enforces
        // that the doc belongs to the authenticated user — sufficient to keep
        // the model from touching arbitrary rows.
        const patch: { title?: string, markdown?: string } = {}
        if (args.title !== undefined) patch.title = args.title
        if (args.markdown !== undefined) patch.markdown = args.markdown
        const doc = await updateUserDocument(user.id, args.documentId, patch, dek)
        followup = `Updated note **${doc.title}** (id ${doc.id}).`
      }
      else if (toolCall.name === 'delete_note') {
        const args = DeleteNoteArgs.parse(toolCall.arguments)
        await softDeleteUserDocument(user.id, args.documentId)
        followup = `Moved note ${args.documentId} to the trash.`
      }
      else {
        followup = `Unknown tool: ${toolCall.name as string}`
      }
    }
    catch (err) {
      const detail = (err as { statusMessage?: string, message?: string }).statusMessage
        ?? (err as Error).message
        ?? 'unknown error'
      followup = `Action failed — \`${toolCall.name}\`: ${detail}`
    }
  }

  const [row] = await db
    .insert(chatMessages)
    .values({
      sessionId,
      role: 'assistant',
      content: encryptChatMessageContent(followup, dek),
      sources: [],
    })
    .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt })

  const createdAt = row?.createdAt instanceof Date
    ? Math.floor(row.createdAt.getTime() / 1000)
    : Number(row?.createdAt ?? 0)

  return {
    ok: true,
    accepted: accept,
    message: {
      id: row?.id ?? null,
      role: 'assistant' as const,
      content: followup,
      sources: [],
      createdAt,
    },
  }
})
