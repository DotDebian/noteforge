/**
 * Bulk operations on a set of document ids. Best-effort: errors on
 * individual documents are collected per-doc rather than transactionally
 * bailing — UI gets a per-doc error list back and can show partial failure.
 *
 * Supported actions:
 *   - move(folderId | null, workspaceId?) — relocate each doc. `workspaceId`
 *     (omitted = keep the doc's own) allows moving ACROSS workspaces, which
 *     re-encrypts the note under the destination workspace key — see
 *     `server/utils/move.ts`.
 *   - trash — soft-delete each doc (idempotent)
 *   - tag-add(tag) — append `tag` to `doc_analyses.tags`; docs without an
 *     analysis row are skipped (we don't fabricate an empty analysis).
 *   - tag-remove(tag) — remove `tag` from `doc_analyses.tags`
 *   - export — stream a ZIP of HTML renders, like the workspace export
 *
 * Selecting a FOLDER in the sidebar acts on every active note inside it
 * (recursively): `folderIds` are expanded to their contained doc ids and
 * unioned with `docIds` before the action runs. So a folder-only selection is
 * valid as long as it resolves to at least one note.
 *
 * ⚠️ `move` is the exception and does NOT expand: a folder is moved AS a
 * folder, subtree and hierarchy intact. Expanding it would drop every note
 * flat into the destination and destroy the structure. A selected note that
 * already lives inside a selected folder is skipped — it travels with it.
 *
 * Body shape (zod):
 *   { action, docIds?, folderIds?, folderId?, workspaceId?, placements?, tag? }
 */
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { createError, defineEventHandler, readValidatedBody, setHeader } from 'h3'
import { useDb } from '~/server/database/client'
import { docAnalyses, documents, folders } from '~/server/database/schema'
import {
  assertDocumentOwnership,
  assertFolderOwnership,
} from '~/server/utils/access'
import { getDek } from '~/server/utils/dek'
import {
  decryptAnalysis,
  decryptDocument,
  encryptAnalysis,
} from '~/server/utils/encrypted-entities'
import { buildHtml, slugify } from '~/server/utils/export'
import { assertMoveTarget, moveUserDocument, moveUserFolder } from '~/server/utils/move'
import {
  analyzeUserDocument,
  collectActiveDocIdsInFolders,
  softDeleteUserDocument,
} from '~/server/utils/notes'
import { requireUser } from '~/server/utils/require-user'
import type { WorkspaceKeyCache } from '~/server/utils/workspace-key'

/** Upper bound on the resolved doc set (docs + folder expansion) per call. */
const MAX_BULK_DOCS = 1000

const Body = z.object({
  action: z.enum(['move', 'trash', 'tag-add', 'tag-remove', 'export', 'analyze']),
  // Either or both may be supplied; folders expand to the notes they contain.
  docIds: z.array(z.number().int().positive()).max(500).optional().default([]),
  folderIds: z.array(z.number().int().positive()).max(200).optional().default([]),
  // Move target (NOT a selection) — kept singular and distinct from `folderIds`.
  folderId: z.number().int().positive().nullable().optional(),
  // Move target workspace. Omitted = each doc keeps its own workspace.
  workspaceId: z.number().int().positive().optional(),
  /**
   * move only — per-document destinations, for when the batch does NOT share
   * one target (undo of a move, restoring a previous layout). Takes precedence
   * over `docIds` / `folderIds` / `folderId` / `workspaceId`.
   */
  placements: z.array(z.object({
    docId: z.number().int().positive(),
    workspaceId: z.number().int().positive(),
    folderId: z.number().int().positive().nullable(),
  })).min(1).max(500).optional(),
  tag: z.string().trim().min(1).max(80).optional(),
})

interface BulkResult {
  ok: number[]
  errors: { docId: number, message: string }[]
  /** move only — folders relocated with their whole subtree. */
  okFolders?: number[]
  folderErrors?: { folderId: number, message: string }[]
  /** move only — destination workspace, echoed so the UI can refresh it. */
  workspaceId?: number
  /** move only — public share links revoked by a cross-workspace re-key. */
  revokedShareTokens?: number
}

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, Body.parse)
  const user = await requireUser(event)
  const dek = await getDek(event)
  const db = useDb()

  /* -------- action: move with per-document destinations -------- */
  // Handled before the folder expansion below: `placements` carries its own
  // doc ids and each one has its own target, so none of the batch-wide
  // resolution applies.
  if (input.action === 'move' && input.placements) {
    const keyCache = (event.context as unknown) as WorkspaceKeyCache
    const result: BulkResult = { ok: [], errors: [], revokedShareTokens: 0 }
    for (const p of input.placements) {
      try {
        const moved = await moveUserDocument(
          user.id,
          p.docId,
          { workspaceId: p.workspaceId, folderId: p.folderId },
          dek,
          keyCache,
        )
        result.revokedShareTokens = (result.revokedShareTokens ?? 0) + moved.revokedShareTokens
        result.ok.push(p.docId)
      }
      catch (err) {
        result.errors.push({ docId: p.docId, message: (err as Error).message || 'failed' })
      }
    }
    return result
  }

  /* -------- action: move -------- */
  // Handled before the folder expansion below, and deliberately NOT sharing it:
  // for every other action a selected folder means "all the notes inside it",
  // but moving a folder must move THE FOLDER — subtree and structure included.
  // Expanding here would land every note flat in the destination and destroy
  // the hierarchy.
  if (input.action === 'move') {
    if (input.folderId === undefined) {
      throw createError({ statusCode: 400, statusMessage: 'folderId is required for move' })
    }
    if (input.docIds.length === 0 && input.folderIds.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Selection is empty' })
    }
    const targetFolderId = input.folderId ?? null

    // Pre-check the destination once; if it's forbidden or inconsistent, fail
    // loudly (one destination for the whole batch — no partial-move semantics
    // make sense here). Without an explicit workspace the destination is
    // per-item, so only the folder can be validated up front.
    if (input.workspaceId !== undefined) {
      await assertMoveTarget(user.id, input.workspaceId, targetFolderId)
    }
    else if (targetFolderId !== null) {
      await assertFolderOwnership(user.id, targetFolderId)
    }

    // Share the per-request key cache across the batch so a shared workspace's
    // WEK is unwrapped once, not once per item.
    const keyCache = (event.context as unknown) as WorkspaceKeyCache
    const result: BulkResult = {
      ok: [], errors: [], okFolders: [], folderErrors: [], revokedShareTokens: 0,
    }
    if (input.workspaceId !== undefined) result.workspaceId = input.workspaceId

    // Ownership first, so the tree walk below only ever reads folders the
    // caller may see.
    const ownedFolderIds: number[] = []
    for (const id of new Set(input.folderIds)) {
      try {
        await assertFolderOwnership(user.id, id)
        ownedFolderIds.push(id)
      }
      catch (err) {
        result.folderErrors!.push({ folderId: id, message: (err as Error).message || 'forbidden' })
      }
    }

    // Selecting a folder AND something already inside it must not move that
    // thing twice: a nested selected folder travels with its ancestor, and so
    // does any selected note living in the subtree.
    let rootFolderIds = ownedFolderIds
    const coveredFolderIds = new Set<number>(ownedFolderIds)
    if (ownedFolderIds.length > 0) {
      const workspaceIds = Array.from(new Set(
        (await db
          .select({ workspaceId: folders.workspaceId })
          .from(folders)
          .where(inArray(folders.id, ownedFolderIds))
        ).map(f => f.workspaceId),
      ))
      const scope = await db
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .where(inArray(folders.workspaceId, workspaceIds))
      const parentOf = new Map(scope.map(f => [f.id, f.parentId ?? null]))
      const selected = new Set(ownedFolderIds)

      const hasSelectedAncestor = (id: number): boolean => {
        let cursor = parentOf.get(id) ?? null
        let safety = 0
        while (cursor !== null && safety < 1000) {
          if (selected.has(cursor)) return true
          cursor = parentOf.get(cursor) ?? null
          safety++
        }
        return false
      }
      rootFolderIds = ownedFolderIds.filter(id => !hasSelectedAncestor(id))

      const childrenOf = new Map<number, number[]>()
      for (const f of scope) {
        if (f.parentId == null) continue
        const bucket = childrenOf.get(f.parentId)
        if (bucket) bucket.push(f.id)
        else childrenOf.set(f.parentId, [f.id])
      }
      const collect = (id: number) => {
        coveredFolderIds.add(id)
        for (const child of childrenOf.get(id) ?? []) collect(child)
      }
      for (const id of rootFolderIds) collect(id)
    }

    for (const folderId of rootFolderIds) {
      try {
        const moved = await moveUserFolder(
          user.id,
          folderId,
          { workspaceId: input.workspaceId ?? null, parentId: targetFolderId },
          dek,
          keyCache,
        )
        result.revokedShareTokens = (result.revokedShareTokens ?? 0) + moved.revokedShareTokens
        result.okFolders!.push(folderId)
      }
      catch (err) {
        result.folderErrors!.push({ folderId, message: (err as Error).message || 'failed' })
      }
    }

    // Notes that live inside a folder we just moved are already at destination.
    const docRows = input.docIds.length > 0
      ? await db
        .select({ id: documents.id, folderId: documents.folderId })
        .from(documents)
        .where(inArray(documents.id, input.docIds))
      : []
    const standaloneDocIds = docRows
      .filter(d => d.folderId == null || !coveredFolderIds.has(d.folderId))
      .map(d => d.id)

    for (const id of standaloneDocIds) {
      try {
        const moved = await moveUserDocument(
          user.id,
          id,
          { workspaceId: input.workspaceId ?? null, folderId: targetFolderId },
          dek,
          keyCache,
        )
        result.revokedShareTokens = (result.revokedShareTokens ?? 0) + moved.revokedShareTokens
        result.ok.push(id)
      }
      catch (err) {
        result.errors.push({ docId: id, message: (err as Error).message || 'failed' })
      }
    }
    return result
  }

  // Expand any selected folders into the active notes they contain (recursive),
  // then union with the explicitly-selected docs. So selecting a folder acts on
  // every note inside it — for analyze/tag/export/move/trash alike.
  const fromFolders = input.folderIds.length > 0
    ? await collectActiveDocIdsInFolders(user.id, input.folderIds)
    : []
  const ids = Array.from(new Set([...input.docIds, ...fromFolders]))
  if (ids.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Selection resolves to no documents' })
  }
  if (ids.length > MAX_BULK_DOCS) {
    throw createError({
      statusCode: 400,
      statusMessage: `Selection too large (${ids.length} notes, max ${MAX_BULK_DOCS})`,
    })
  }

  /* -------- action: export (streams a ZIP, returns response directly) -------- */
  if (input.action === 'export') {
    const docRows: typeof documents.$inferSelect[] = []
    const errors: { docId: number, message: string }[] = []
    for (const id of ids) {
      try {
        const doc = await assertDocumentOwnership(user.id, id)
        if (doc.deletedAt != null) throw new Error('Document is in trash')
        // buildHtml needs plaintext markdown + title for the export.
        docRows.push(decryptDocument(doc, dek))
      }
      catch (err) {
        errors.push({ docId: id, message: (err as Error).message || 'forbidden' })
      }
    }
    if (docRows.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No exportable documents' })
    }

    const archive = archiver('zip', { zlib: { level: 6 } })
    const res = event.node.res

    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') console.error('[bulk export] archive warning', err)
    })
    archive.on('error', (err) => {
      console.error('[bulk export] archive error', err)
      try { res.destroy(err) }
      catch {}
    })

    setHeader(event, 'Content-Type', 'application/zip')
    setHeader(event, 'Content-Disposition', `attachment; filename="documents-${Date.now()}.zip"`)

    archive.pipe(res)

    // Name collision guard — same baseSlug shows up twice => `-2.html`.
    const used = new Map<string, number>()
    for (const doc of docRows) {
      const baseSlug = slugify(doc.title || 'untitled')
      const used_n = used.get(baseSlug) ?? 0
      used.set(baseSlug, used_n + 1)
      const fileName = used_n === 0 ? `${baseSlug}.html` : `${baseSlug}-${used_n + 1}.html`
      const content = buildHtml(doc)
      archive.append(Readable.from(content), { name: fileName })
    }

    const finished = new Promise<void>((resolve, reject) => {
      res.on('finish', () => resolve())
      res.on('close', () => resolve())
      res.on('error', reject)
    })

    void archive.finalize()
    await finished
    return event.node.res
  }

  /* -------- action: trash -------- */
  if (input.action === 'trash') {
    const result: BulkResult = { ok: [], errors: [] }
    for (const id of ids) {
      try {
        await softDeleteUserDocument(user.id, id)
        result.ok.push(id)
      }
      catch (err) {
        result.errors.push({ docId: id, message: (err as Error).message || 'failed' })
      }
    }
    return result
  }

  /* -------- action: tag-add / tag-remove -------- */
  if (input.action === 'tag-add' || input.action === 'tag-remove') {
    if (!input.tag) {
      throw createError({ statusCode: 400, statusMessage: 'tag is required' })
    }
    const tagNorm = input.tag.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-')
    if (tagNorm.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'tag is empty after normalisation' })
    }

    const result: BulkResult = { ok: [], errors: [] }

    // Verify ownership for every id first so we don't leak existence.
    const owned: number[] = []
    for (const id of ids) {
      try {
        await assertDocumentOwnership(user.id, id)
        owned.push(id)
      }
      catch (err) {
        result.errors.push({ docId: id, message: (err as Error).message || 'forbidden' })
      }
    }
    if (owned.length === 0) return result

    const analyses = await db
      .select({ docId: docAnalyses.docId, tags: docAnalyses.tags })
      .from(docAnalyses)
      .where(inArray(docAnalyses.docId, owned))
    // Decrypt tags so we can do case-insensitive contains/remove. Re-encrypt
    // before writing back.
    const byDoc = new Map<number, string[]>(
      analyses.map((a) => {
        const tags = decryptAnalysis({ tags: Array.isArray(a.tags) ? a.tags : [] }, dek).tags ?? []
        return [a.docId, tags]
      }),
    )

    for (const id of owned) {
      const existing = byDoc.get(id)
      if (!existing) {
        // No analysis row — skip (and report as error so the UI can surface it).
        result.errors.push({ docId: id, message: 'no analysis — analyze the document first' })
        continue
      }
      const dedup = existing.map(t => t.toLowerCase())
      let next: string[]
      if (input.action === 'tag-add') {
        if (dedup.includes(tagNorm)) {
          result.ok.push(id)
          continue
        }
        next = [...existing, tagNorm]
      }
      else {
        if (!dedup.includes(tagNorm)) {
          result.ok.push(id)
          continue
        }
        next = existing.filter(t => t.toLowerCase() !== tagNorm)
      }
      try {
        const nextEncrypted = encryptAnalysis({ tags: next }, dek).tags!
        await db
          .update(docAnalyses)
          .set({ tags: nextEncrypted })
          .where(eq(docAnalyses.docId, id))
        result.ok.push(id)
      }
      catch (err) {
        result.errors.push({ docId: id, message: (err as Error).message || 'failed' })
      }
    }
    return result
  }

  /* -------- action: analyze -------- */
  if (input.action === 'analyze') {
    const result: BulkResult = { ok: [], errors: [] }
    for (const id of ids) {
      try {
        await analyzeUserDocument(user.id, id, dek)
        result.ok.push(id)
      }
      catch (err) {
        result.errors.push({ docId: id, message: (err as Error).message || 'failed' })
      }
    }
    return result
  }

  throw createError({ statusCode: 400, statusMessage: 'unsupported action' })
})
