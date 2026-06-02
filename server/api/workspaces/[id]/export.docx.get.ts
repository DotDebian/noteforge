/**
 * Workspace DOCX export: a single big DOCX concatenating every document
 * in the workspace. Same ordering as the PDF endpoint (folder pre-order,
 * `position` within each folder). Each doc starts after a page break.
 *
 * Choice of format: a single DOCX (NOT a ZIP of per-doc DOCX). Rationale —
 * users who want a single editable artefact (e.g. handing off to someone
 * who lives in Word) get the entire workspace in one place; the existing
 * HTML/Markdown ZIP covers the per-file shape. If the workspace is large
 * the output is still <50 MB for typical text-heavy content.
 */

import { and, asc, eq } from 'drizzle-orm'
import { defineEventHandler, setHeader } from 'h3'

import { useDb } from '~/server/database/client'
import { documents, folders } from '~/server/database/schema'
import type { Document, Folder } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere, activeFoldersWhere } from '~/server/utils/active'
import { decryptDocument, decryptFolder } from '~/server/utils/encrypted-entities'
import { slugify } from '~/server/utils/export'
import { renderWorkspaceDocx } from '~/server/utils/export-docx'
import { getWorkspaceKeyFromWorkspace } from '~/server/utils/workspace-key'

function orderDocs(folderRows: Folder[], docRows: Document[]): Document[] {
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

  const seen = new Set(out)
  for (const doc of docRows) {
    if (!seen.has(doc)) out.push(doc)
  }
  return out
}

export default defineEventHandler(async (event) => {
  const id = parseIdParam(event)
  const workspace = await assertWorkspaceAccess(event, id)
  const key = await getWorkspaceKeyFromWorkspace(event, workspace)
  const db = useDb()

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

  const ordered = orderDocs(folderRows, docRows)
  const buf = await renderWorkspaceDocx(workspace.name || 'Workspace', ordered)
  const filename = `${slugify(workspace.name || 'workspace')}.docx`

  setHeader(
    event,
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', buf.byteLength)
  return buf
})
