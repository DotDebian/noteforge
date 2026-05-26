import { z } from 'zod'
import { and, asc, desc, eq, isNull, type SQL } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { documents } from '~/server/database/schema'
import { assertFolderAccess, assertWorkspaceAccess } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { decryptField, encryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import {
  mistralFileSignedUrl,
  mistralOcr,
  mistralUploadFile,
} from '~/server/utils/mistral'

const MAX_FILES = 20
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024 // 50 MB
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 // 100 MB

const ALLOWED_MIMES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
  'image/gif',
])

const IMAGE_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
  'image/gif',
])

const FileEntry = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(100),
  contentBase64: z.string().min(1),
})

const Body = z.object({
  workspaceId: z.number().int().positive(),
  parentFolderId: z.number().int().positive().nullable(),
  files: z.array(FileEntry).min(1).max(MAX_FILES),
})

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, Body.parse)
  await assertWorkspaceAccess(event, input.workspaceId)
  const dek = await getDek(event)

  if (input.parentFolderId !== null) {
    const parent = await assertFolderAccess(event, input.parentFolderId)
    if (parent.workspaceId !== input.workspaceId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Parent folder must belong to the same workspace',
      })
    }
  }

  // Pre-validate mimes and sizes before doing any upstream work.
  let totalBytes = 0
  for (const f of input.files) {
    const mime = f.mime.toLowerCase()
    if (!ALLOWED_MIMES.has(mime)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Unsupported file type: ${f.mime} (${f.name})`,
      })
    }
    // base64 inflates by ~4/3. Rough size estimate from string length.
    const approxBytes = Math.floor((f.contentBase64.length * 3) / 4)
    if (approxBytes > MAX_BYTES_PER_FILE) {
      throw createError({
        statusCode: 400,
        statusMessage: `File too large: ${f.name} (max ${Math.round(MAX_BYTES_PER_FILE / (1024 * 1024))} MB)`,
      })
    }
    totalBytes += approxBytes
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw createError({
        statusCode: 400,
        statusMessage: `Total payload exceeds ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB`,
      })
    }
  }

  const db = useDb()
  const now = new Date()

  const usedTitlesByFolder = new Map<number | null, Set<string>>()

  async function reserveTitle(folderId: number | null, baseTitle: string): Promise<string> {
    let used = usedTitlesByFolder.get(folderId)
    if (!used) {
      used = new Set<string>()
      const folderCondition: SQL = folderId === null
        ? isNull(documents.folderId)
        : eq(documents.folderId, folderId)
      const rows = await db
        .select({ title: documents.title })
        .from(documents)
        .where(and(
          eq(documents.workspaceId, input.workspaceId),
          folderCondition,
          activeDocsWhere(),
        ))
      for (const r of rows) used.add(decryptField(r.title, dek).toLowerCase())
      usedTitlesByFolder.set(folderId, used)
    }
    let candidate = baseTitle
    let n = 2
    while (used.has(candidate.toLowerCase())) {
      candidate = `${baseTitle} (${n++})`
    }
    used.add(candidate.toLowerCase())
    return candidate
  }

  async function nextPosition(folderId: number | null): Promise<number> {
    const folderCondition: SQL = folderId === null
      ? isNull(documents.folderId)
      : eq(documents.folderId, folderId)
    const [row] = await db
      .select({ position: documents.position })
      .from(documents)
      .where(and(
        eq(documents.workspaceId, input.workspaceId),
        folderCondition,
        activeDocsWhere(),
      ))
      .orderBy(desc(documents.position), asc(documents.id))
      .limit(1)
    return (row?.position ?? 0) + 1024
  }

  const createdDocs: { id: number, title: string, folderId: number | null }[] = []
  const skipped: { name: string, reason: string }[] = []

  for (const file of input.files) {
    const mime = file.mime.toLowerCase()
    let bytes: Buffer
    try {
      bytes = Buffer.from(file.contentBase64, 'base64')
    }
    catch {
      skipped.push({ name: file.name, reason: 'invalid base64' })
      continue
    }
    if (bytes.length === 0) {
      skipped.push({ name: file.name, reason: 'empty file' })
      continue
    }

    let signedUrl: string
    try {
      const fileId = await mistralUploadFile(file.name, bytes, mime)
      signedUrl = await mistralFileSignedUrl(fileId, 1)
    }
    catch (err) {
      skipped.push({ name: file.name, reason: (err as Error).message || 'upload failed' })
      continue
    }

    let markdown = ''
    try {
      const out = await mistralOcr(signedUrl, IMAGE_MIMES.has(mime) ? 'image' : 'document')
      markdown = out.markdown
    }
    catch (err) {
      skipped.push({ name: file.name, reason: (err as Error).message || 'OCR failed' })
      continue
    }

    if (!markdown.trim()) {
      markdown = '*(no text extracted)*'
    }

    const baseTitle = deriveTitle(markdown, file.name)
    const finalTitle = await reserveTitle(input.parentFolderId, baseTitle)
    const pos = await nextPosition(input.parentFolderId)

    const [created] = await db
      .insert(documents)
      .values({
        workspaceId: input.workspaceId,
        folderId: input.parentFolderId,
        title: encryptField(finalTitle, dek),
        markdown: encryptField(markdown, dek),
        contentJson: encryptField('{}', dek),
        position: pos,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id, title: documents.title, folderId: documents.folderId })

    if (!created) {
      throw createError({ statusCode: 500, statusMessage: 'Failed to create document' })
    }
    createdDocs.push({
      id: created.id,
      title: finalTitle,
      folderId: created.folderId ?? null,
    })
  }

  return {
    documents: createdDocs,
    skipped,
  }
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const IMG_EXT_RE = /\.(pdf|png|jpe?g|webp|avif|gif)$/i
const H1_RE = /^#\s+(.+?)\s*$/m

function sanitizeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function deriveTitle(body: string, filename: string): string {
  const h1 = H1_RE.exec(body)
  if (h1 && h1[1]) {
    const t = sanitizeName(h1[1])
    if (t) return t
  }
  const stripped = filename.replace(IMG_EXT_RE, '')
  return sanitizeName(stripped) || 'Imported document'
}
