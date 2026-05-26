import { z } from 'zod'
import { and, asc, desc, eq, isNull, type SQL } from 'drizzle-orm'
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders, type Folder } from '~/server/database/schema'
import { assertFolderAccess, assertWorkspaceAccess } from '~/server/utils/access'
import { activeDocsWhere, activeFoldersWhere } from '~/server/utils/active'
import { decryptField, encryptField } from '~/server/utils/crypto'
import { getDek } from '~/server/utils/dek'
import { parseFrontmatter } from '~/server/utils/frontmatter'

const MAX_FILES = 200
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024 // 10 MB total content bytes
const MAX_DEPTH = 10

const FileEntry = z.object({
  path: z.string().min(1).max(2048),
  content: z.string(),
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

  // Payload size guard (sum of content bytes).
  let totalBytes = 0
  for (const f of input.files) {
    totalBytes += Buffer.byteLength(f.content, 'utf8')
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      throw createError({
        statusCode: 400,
        statusMessage: `Payload exceeds ${Math.round(MAX_PAYLOAD_BYTES / (1024 * 1024))} MB`,
      })
    }
  }

  const db = useDb()
  const now = new Date()

  // Cache: parent-id (or null) + segment → folder row. Avoids duplicate
  // INSERTs when many files share intermediate path segments.
  const folderCache = new Map<string, Folder>()
  const createdFolders: Folder[] = []

  const cacheKey = (parentId: number | null, name: string) =>
    `${parentId ?? 'root'}::${name.toLowerCase()}`

  async function findOrCreateFolder(parentId: number | null, rawName: string): Promise<Folder> {
    const name = sanitizeName(rawName) || 'Untitled folder'
    const key = cacheKey(parentId, name)
    const cached = folderCache.get(key)
    if (cached) return cached

    // Look up existing folder with same parent + same (case-insensitive) name.
    const parentCondition: SQL = parentId === null
      ? isNull(folders.parentId)
      : eq(folders.parentId, parentId)

    const existing = await db
      .select()
      .from(folders)
      .where(and(
        eq(folders.workspaceId, input.workspaceId),
        parentCondition,
        activeFoldersWhere(),
      ))

    // Names on disk are encrypted; decrypt each before name-comparison.
    const match = existing.find(f => decryptField(f.name, dek).toLowerCase() === name.toLowerCase())
    if (match) {
      // Surface plaintext on the cached row so callers can read it without
      // re-decrypting.
      const decrypted: Folder = { ...match, name: decryptField(match.name, dek) }
      folderCache.set(key, decrypted)
      return decrypted
    }

    // Compute next position: max position among siblings + 1024.
    const maxPos = existing.reduce((acc, f) => Math.max(acc, f.position), 0)

    const [created] = await db
      .insert(folders)
      .values({
        workspaceId: input.workspaceId,
        parentId,
        name: encryptField(name, dek),
        position: maxPos + 1024,
      })
      .returning()

    if (!created) {
      throw createError({ statusCode: 500, statusMessage: 'Failed to create folder' })
    }
    const plain: Folder = { ...created, name }
    folderCache.set(key, plain)
    createdFolders.push(plain)
    return plain
  }

  // Tracks the (folderId → set of normalized titles) we've imported in this
  // batch so duplicate-name disambiguation accounts for in-flight inserts.
  const usedTitlesByFolder = new Map<number | null, Set<string>>()

  async function reserveTitle(folderId: number | null, baseTitle: string): Promise<string> {
    const used = usedTitlesByFolder.get(folderId) ?? new Set<string>()
    if (used.size === 0) {
      // Seed with existing titles in this folder so we don't collide with
      // pre-existing docs either.
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

  for (const file of input.files) {
    const segments = normalizePath(file.path)
    if (segments.length === 0) continue
    if (segments.length - 1 > MAX_DEPTH) {
      throw createError({
        statusCode: 400,
        statusMessage: `Path nesting exceeds depth ${MAX_DEPTH}: ${file.path}`,
      })
    }

    const filename = segments[segments.length - 1]
    if (!filename || !hasMarkdownExt(filename)) continue

    // Walk path segments to find/create folder chain.
    let currentParent: number | null = input.parentFolderId
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      if (!seg) continue
      const folder = await findOrCreateFolder(currentParent, seg)
      currentParent = folder.id
    }

    const parsed = parseFrontmatter(file.content)
    const baseTitle = deriveTitle(parsed.title, parsed.body, filename)
    const finalTitle = await reserveTitle(currentParent, baseTitle)
    const pos = await nextPosition(currentParent)

    const [created] = await db
      .insert(documents)
      .values({
        workspaceId: input.workspaceId,
        folderId: currentParent,
        title: encryptField(finalTitle, dek),
        markdown: encryptField(parsed.body, dek),
        contentJson: encryptField('{}', dek),
        position: pos,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id, title: documents.title, folderId: documents.folderId })

    if (!created) {
      throw createError({ statusCode: 500, statusMessage: 'Failed to create document' })
    }
    // We already know the plaintext (`finalTitle`); avoid a round-trip decrypt.
    createdDocs.push({
      id: created.id,
      title: finalTitle,
      folderId: created.folderId ?? null,
    })
  }

  return {
    documents: createdDocs,
    folders: createdFolders.map(f => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null,
    })),
  }
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const MD_EXTENSIONS = ['.md', '.markdown', '.txt'] as const

function hasMarkdownExt(name: string): boolean {
  const lower = name.toLowerCase()
  return MD_EXTENSIONS.some(ext => lower.endsWith(ext))
}

function stripExt(name: string): string {
  const lower = name.toLowerCase()
  for (const ext of MD_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, -ext.length)
  }
  return name
}

/**
 * Strip control chars + collapse whitespace, trim. Mirrors what the user
 * would see if they pasted the name into our prompt dialog.
 */
function sanitizeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * Split a posix-ish path into segments, dropping empty parts, `.`, and
 * defending against `..` traversal (treated as a literal segment, sanitized).
 */
function normalizePath(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s !== '.')
    .map(s => (s === '..' ? '__parent__' : s))
}

const H1_RE = /^#\s+(.+?)\s*$/m

function deriveTitle(
  frontmatterTitle: string | undefined,
  body: string,
  filename: string,
): string {
  if (frontmatterTitle) {
    const t = sanitizeName(frontmatterTitle)
    if (t) return t.slice(0, 200)
  }
  const h1 = H1_RE.exec(body)
  if (h1 && h1[1]) {
    const t = sanitizeName(h1[1])
    if (t) return t.slice(0, 200)
  }
  const fromFile = sanitizeName(stripExt(filename))
  return (fromFile || 'Untitled').slice(0, 200)
}
