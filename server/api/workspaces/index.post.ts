import { z } from 'zod'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, workspaces } from '~/server/database/schema'
import { getDek } from '~/server/utils/dek'
import {
  decryptWorkspace,
  encryptDocument,
  encryptWorkspace,
} from '~/server/utils/encrypted-entities'
import { requireUser } from '~/server/utils/require-user'
import {
  WELCOME_DOCUMENT_MARKDOWN,
  WELCOME_DOCUMENT_TITLE,
} from '~/server/utils/welcome-document'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  emoji: z.string().trim().max(8).optional(),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const dek = await getDek(event)
  const input = await readValidatedBody(event, Body.parse)

  const db = useDb()
  const encryptedName = encryptWorkspace({ name: input.name }, dek).name!
  const [created] = await db
    .insert(workspaces)
    .values({
      ownerId: user.id,
      name: encryptedName,
      emoji: input.emoji ?? null,
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create workspace' })
  }

  // Seed the welcome document at the workspace root. Failure-soft: the
  // workspace itself is already persisted, so a problem here shouldn't
  // bubble up to the user — they can always create docs manually.
  try {
    const welcomeEnc = encryptDocument({
      title: WELCOME_DOCUMENT_TITLE,
      markdown: WELCOME_DOCUMENT_MARKDOWN,
      contentJson: '{}',
    }, dek)
    await db.insert(documents).values({
      workspaceId: created.id,
      folderId: null,
      title: welcomeEnc.title!,
      markdown: welcomeEnc.markdown!,
      contentJson: welcomeEnc.contentJson!,
      position: 0,
    })
  }
  catch (err) {
    console.error('[workspaces] failed to seed welcome document for workspace', created.id, err)
  }

  return { workspace: decryptWorkspace(created, dek) }
})
