import { Readable } from 'node:stream'
import archiver from 'archiver'
import { and, asc, eq } from 'drizzle-orm'
import { defineEventHandler, getQuery } from 'h3'
import { useDb } from '~/server/database/client'
import { documents, folders } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere, activeFoldersWhere } from '~/server/utils/active'
import { decryptDocument, decryptFolder } from '~/server/utils/encrypted-entities'
import { buildHtml, buildMarkdown, slugify } from '~/server/utils/export'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

type ExportFormat = 'markdown' | 'html'

function parseFormat(value: unknown): ExportFormat {
  if (value === 'html') return 'html'
  return 'markdown'
}

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const workspace = await assertWorkspaceAccess(event, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const db = useDb()

  const format = parseFormat(getQuery(event).format)
  const extension = format === 'html' ? 'html' : 'md'
  const renderBody = format === 'html' ? buildHtml : buildMarkdown

  const folderRows = (await db
    .select()
    .from(folders)
    .where(and(eq(folders.workspaceId, workspace.id), activeFoldersWhere()))
    .orderBy(asc(folders.position), asc(folders.id)))
    .map(folder => decryptFolder(folder, key))

  const docRows = (await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, workspace.id), activeDocsWhere()))
    .orderBy(asc(documents.position), asc(documents.id)))
    .map(doc => decryptDocument(doc, key))

  // Build folderId -> path segments (slugified folder names from root down).
  const folderById = new Map<number, typeof folderRows[number]>()
  for (const f of folderRows) folderById.set(f.id, f)

  const pathCache = new Map<number, string[]>()
  function segmentsFor(folderId: number | null): string[] {
    if (folderId == null) return []
    const cached = pathCache.get(folderId)
    if (cached) return cached
    const folder = folderById.get(folderId)
    if (!folder) {
      // Orphan — treat as root.
      pathCache.set(folderId, [])
      return []
    }
    const parentSegs = segmentsFor(folder.parentId ?? null)
    const segs = [...parentSegs, slugify(folder.name || 'folder')]
    pathCache.set(folderId, segs)
    return segs
  }

  const res = event.node.res
  const archive = archiver('zip', { zlib: { level: 6 } })

  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') {
      console.error('[workspace export] archive warning', err)
    }
  })
  archive.on('error', (err) => {
    console.error('[workspace export] archive error', err)
    try { res.destroy(err) }
    catch {}
  })

  const wsSlug = slugify(workspace.name || 'workspace')
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${wsSlug}.zip"`)

  archive.pipe(res)

  // Track per-folder-path name collisions: Map<dirPath, Map<baseSlug, count>>
  const usedNames = new Map<string, Map<string, number>>()
  function reserveName(dir: string, baseSlug: string): string {
    let counters = usedNames.get(dir)
    if (!counters) {
      counters = new Map()
      usedNames.set(dir, counters)
    }
    const existing = counters.get(baseSlug)
    if (!existing) {
      counters.set(baseSlug, 1)
      return `${baseSlug}.${extension}`
    }
    const next = existing + 1
    counters.set(baseSlug, next)
    return `${baseSlug}-${next}.${extension}`
  }

  for (const doc of docRows) {
    const segs = segmentsFor(doc.folderId ?? null)
    const dir = segs.join('/')
    const baseSlug = slugify(doc.title || 'untitled')
    const fileName = reserveName(dir, baseSlug)
    const fullPath = dir ? `${dir}/${fileName}` : fileName

    const content = renderBody(doc)
    archive.append(Readable.from(content), { name: fullPath })
  }

  // Wait for the underlying Node response to drain before resolving the
  // handler — otherwise h3 may try to send an empty body on top of the
  // already-piped archive.
  const finished = new Promise<void>((resolve, reject) => {
    res.on('finish', () => resolve())
    res.on('close', () => resolve())
    res.on('error', reject)
  })

  void archive.finalize()
  await finished

  // Signal h3 that the response has been handled directly.
  return event.node.res
})
