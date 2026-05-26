/**
 * Workspace PDF export: a single big PDF concatenating every document in
 * the workspace. Documents are ordered by folder hierarchy (folder name,
 * pre-order traversal of the tree) then by `position` within each folder.
 * Each doc starts on a fresh page with its title heading.
 *
 * Choice of format: a single PDF (NOT a ZIP of per-doc PDFs). Rationale —
 * the HTML export already ships as a ZIP; the PDF / DOCX exports cover the
 * other axis ("I want one printable artefact for the whole knowledge
 * base"). If users want per-doc PDFs they can hit the doc-level endpoint.
 */

import { and, asc, eq } from 'drizzle-orm'
import { defineEventHandler, setHeader } from 'h3'

import { useDb } from '~/server/database/client'
import { documents, folders } from '~/server/database/schema'
import type { Document, Folder } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere, activeFoldersWhere } from '~/server/utils/active'
import { slugify } from '~/server/utils/export'
import { renderWorkspacePdf } from '~/server/utils/export-pdf'

function orderDocs(folderRows: Folder[], docRows: Document[]): Document[] {
  // Pre-order traversal of the folder tree. We sort children alphabetically
  // by folder name then `position` so output ordering is stable. Docs that
  // sit at the root (folderId == null) come first, then each subtree in
  // turn.
  const childrenByParent = new Map<number | null, Folder[]>()
  for (const folder of folderRows) {
    const parent = folder.parentId ?? null
    const list = childrenByParent.get(parent)
    if (list) list.push(folder)
    else childrenByParent.set(parent, [folder])
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position
      return a.name.localeCompare(b.name)
    })
  }

  const docsByFolder = new Map<number | null, Document[]>()
  for (const doc of docRows) {
    const key = doc.folderId ?? null
    const list = docsByFolder.get(key)
    if (list) list.push(doc)
    else docsByFolder.set(key, [doc])
  }
  for (const list of docsByFolder.values()) {
    list.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position
      return a.id - b.id
    })
  }

  const out: Document[] = []
  const visit = (folderId: number | null): void => {
    const docs = docsByFolder.get(folderId) ?? []
    out.push(...docs)
    const children = childrenByParent.get(folderId) ?? []
    for (const child of children) visit(child.id)
  }
  visit(null)

  // Catch any orphans (folderId points to a missing folder) so they're not
  // silently dropped.
  const seen = new Set(out)
  for (const doc of docRows) {
    if (!seen.has(doc)) out.push(doc)
  }
  return out
}

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const workspace = await assertWorkspaceAccess(event, id)
  const db = useDb()

  const folderRows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.workspaceId, workspace.id), activeFoldersWhere()))
    .orderBy(asc(folders.position), asc(folders.id))

  const docRows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, workspace.id), activeDocsWhere()))
    .orderBy(asc(documents.position), asc(documents.id))

  const ordered = orderDocs(folderRows, docRows)
  const buf = await renderWorkspacePdf(workspace.name || 'Workspace', ordered)
  const filename = `${slugify(workspace.name || 'workspace')}.pdf`

  setHeader(event, 'Content-Type', 'application/pdf')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', buf.byteLength)
  return buf
})
