/**
 * Document moves — within a workspace and, crucially, ACROSS workspaces.
 *
 * A same-workspace move is just a `folderId` update and delegates to
 * `updateUserDocument`. A cross-workspace move is a different beast: each
 * workspace has its own content key (the owner's DEK for solo `'dek'`
 * workspaces, the shared WEK for `'wek'` ones — see `workspace-key.ts`), so
 * moving a note means **re-encrypting everything hanging off it** under the
 * destination key:
 *
 *   - `documents.title / markdown / content_json`
 *   - `document_versions.*` (the whole history travels with the note)
 *   - `doc_analyses` summaries + the per-string-encrypted JSON columns
 *   - `doc_chunks.text`
 *
 * Embeddings (`embedding_blob`, `summary_embedding`) and the `doc_chunks_fts`
 * mirror are cleartext by design and describe text that hasn't changed — they
 * are left untouched, so retrieval keeps working right after the move.
 *
 * Two side effects are unavoidable and are reported back to the caller:
 *   - **doc links**: `doc_links` is workspace-scoped (`reconcileDocLinks`
 *     drops cross-workspace targets), so links in either direction that now
 *     straddle two workspaces are removed.
 *   - **public share tokens**: `share_tokens.wrapped_key` wraps the OLD
 *     workspace key under a key derived from the raw token, which we don't
 *     have (only its hash). Re-wrapping is impossible, so active tokens for a
 *     re-keyed document are revoked instead of silently breaking.
 *
 * The whole rewrite runs in one better-sqlite3 transaction — a note is never
 * left in the destination workspace still encrypted under the source key.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { getRawDb, useDb } from '~/server/database/client'
import {
  documents,
  folders,
  type Document,
  type Folder,
  type Workspace,
} from '~/server/database/schema'
import {
  assertCanEdit,
  assertDocumentMembership,
  assertFolderMembership,
  assertWorkspaceMembership,
} from './access'
import { decryptField, encryptField, isEncrypted } from './crypto'
import { extractDocLinks, reconcileDocLinks } from './doc-links'
import { decryptDocument, decryptFolder } from './encrypted-entities'
import { updateUserDocument, updateUserFolder } from './notes'
import { getWorkspaceKeyForUserById, type WorkspaceKeyCache } from './workspace-key'

export interface MoveDocumentTarget {
  /** Destination workspace. Omitted / null keeps the document where it is. */
  workspaceId?: number | null
  /** Destination folder inside that workspace — `null` means workspace root. */
  folderId: number | null
}

export interface MoveDocumentResult {
  /** The moved row, decrypted under the DESTINATION key. */
  document: Document
  /** True when the document changed workspace. */
  crossWorkspace: boolean
  /** True when content had to be re-encrypted (source and target keys differ). */
  rekeyed: boolean
  /** Public share links revoked because their wrapped key went stale. */
  revokedShareTokens: number
}

/**
 * Validate a move destination for `userId`: workspace membership + edit
 * right, and (when given) that the folder is an active folder of THAT
 * workspace. Exported so callers can fail fast once for a whole batch
 * instead of collecting the same error N times.
 */
export async function assertMoveTarget(
  userId: number,
  workspaceId: number,
  folderId: number | null,
): Promise<{ workspace: Workspace, folder: Folder | null }> {
  const { workspace, role } = await assertWorkspaceMembership(userId, workspaceId)
  assertCanEdit(role)

  if (folderId == null) return { workspace, folder: null }

  const db = useDb()
  const [folder] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1)
  if (!folder || folder.deletedAt != null) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }
  if (folder.workspaceId !== workspace.id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Folder must belong to the target workspace',
    })
  }
  return { workspace, folder }
}

/** Byte-equality on two optional keys — `null` (no key at all) counts as equal. */
function sameKey(a: Buffer | null, b: Buffer | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.equals(b)
}

/**
 * Move a document to `target`. Handles both the same-workspace case (plain
 * folder change) and the cross-workspace case (re-key + relocation).
 *
 * `dek` is the caller's Data Encryption Key; the source and destination
 * workspace keys are resolved from it, so a member of a shared workspace can
 * move notes in and out of it exactly like a solo one.
 */
export async function moveUserDocument(
  userId: number,
  docId: number,
  target: MoveDocumentTarget,
  dek: Buffer | null = null,
  cache?: WorkspaceKeyCache,
): Promise<MoveDocumentResult> {
  const { document: doc, role } = await assertDocumentMembership(userId, docId)
  assertCanEdit(role)
  if (doc.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: 'Document is in trash' })
  }

  const targetWorkspaceId = target.workspaceId ?? doc.workspaceId
  await assertMoveTarget(userId, targetWorkspaceId, target.folderId)

  const sourceKey = await getWorkspaceKeyForUserById(userId, doc.workspaceId, dek, cache)

  /* ---------------- same workspace: nothing to re-encrypt ---------------- */
  if (targetWorkspaceId === doc.workspaceId) {
    const updated = await updateUserDocument(
      userId,
      docId,
      { folderId: target.folderId },
      sourceKey,
    )
    return { document: updated, crossWorkspace: false, rekeyed: false, revokedShareTokens: 0 }
  }

  /* ------------------------- cross-workspace move ------------------------ */
  const targetKey = await getWorkspaceKeyForUserById(userId, targetWorkspaceId, dek, cache)
  const rekeyed = !sameKey(sourceKey, targetKey)

  // One key present and the other missing means we'd either strip encryption
  // or lock the note away under an envelope nobody can open. Refuse rather
  // than write something unreadable.
  if (rekeyed && (!sourceKey || !targetKey)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'missing_key',
      data: { detail: 'Cannot re-encrypt this document for the target workspace.' },
    })
  }

  // Fail before touching anything if the source key doesn't actually open the
  // note — better a clean 409 than a half-readable row in the destination.
  let plainMarkdown = ''
  try {
    plainMarkdown = decryptDocument(doc, sourceKey).markdown
  }
  catch {
    throw createError({
      statusCode: 409,
      statusMessage: 'decrypt_failed',
      data: { detail: 'Document could not be decrypted with the source workspace key.' },
    })
  }

  const db = useDb()

  // Append at the end of the destination location.
  const [{ maxPosition = -1 } = { maxPosition: -1 }] = await db
    .select({ maxPosition: sql<number>`coalesce(max(${documents.position}), -1)`.mapWith(Number) })
    .from(documents)
    .where(and(
      eq(documents.workspaceId, targetWorkspaceId),
      target.folderId == null ? isNull(documents.folderId) : eq(documents.folderId, target.folderId),
      isNull(documents.deletedAt),
    ))

  const revokedShareTokens = relocateDocumentRows({
    docId,
    targetWorkspaceId,
    targetFolderId: target.folderId,
    position: maxPosition + 1,
    oldKey: rekeyed ? sourceKey! : null,
    newKey: rekeyed ? targetKey! : null,
  })

  // Wiki-links pointing at the old workspace are gone (deleted above); a link
  // that happened to point INTO the destination workspace becomes valid now.
  try {
    await reconcileDocLinks(docId, extractDocLinks(plainMarkdown, targetWorkspaceId))
  }
  catch (err) {
    console.error('[doc-links] reconcile failed after move for doc', docId, err)
  }

  const [moved] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1)
  if (!moved) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }

  return {
    document: decryptDocument(moved, targetKey),
    crossWorkspace: true,
    rekeyed,
    revokedShareTokens,
  }
}

/* -------------------------------------------------------------------------- */
/*  Folders                                                                    */
/* -------------------------------------------------------------------------- */

export interface MoveFolderTarget {
  /** Destination workspace. Omitted / null keeps the folder where it is. */
  workspaceId?: number | null
  /** Destination parent folder — `null` means workspace root. */
  parentId: number | null
}

export interface MoveFolderResult {
  folder: Folder
  crossWorkspace: boolean
  rekeyed: boolean
  /** Subfolders carried along (excluding the moved folder itself). */
  movedFolders: number
  /** Notes carried along, trashed ones included. */
  movedDocuments: number
  revokedShareTokens: number
}

/**
 * Move a folder **with its whole subtree** — subfolders, notes, and their
 * content. This is what "move" means for a folder; flattening its notes into
 * the destination would destroy the structure the user built.
 *
 * Cross-workspace, the same re-key applies as for a single note, extended to
 * every folder name and every document in the subtree. Trashed rows travel too:
 * leaving them behind would orphan them under a parent that no longer lives in
 * their workspace.
 */
export async function moveUserFolder(
  userId: number,
  folderId: number,
  target: MoveFolderTarget,
  dek: Buffer | null = null,
  cache?: WorkspaceKeyCache,
): Promise<MoveFolderResult> {
  const { folder, role } = await assertFolderMembership(userId, folderId)
  assertCanEdit(role)
  if (folder.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: 'Folder is in trash' })
  }

  const targetWorkspaceId = target.workspaceId ?? folder.workspaceId
  await assertMoveTarget(userId, targetWorkspaceId, target.parentId)

  const db = useDb()

  // Subtree ids, walked from the source workspace's folder rows. Trashed
  // folders included — see the doc comment.
  const allFolders = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.workspaceId, folder.workspaceId))
  const childrenOf = new Map<number | null, number[]>()
  for (const f of allFolders) {
    const key = f.parentId ?? null
    const bucket = childrenOf.get(key)
    if (bucket) bucket.push(f.id)
    else childrenOf.set(key, [f.id])
  }
  const subtree: number[] = []
  const walk = (id: number) => {
    subtree.push(id)
    for (const child of childrenOf.get(id) ?? []) walk(child)
  }
  walk(folderId)

  // A folder can't become its own descendant.
  if (target.parentId != null && subtree.includes(target.parentId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Cannot move a folder into itself or one of its subfolders',
    })
  }

  const subtreeDocs = await db
    .select({ id: documents.id, markdown: documents.markdown })
    .from(documents)
    .where(inArray(documents.folderId, subtree))

  const sourceKey = await getWorkspaceKeyForUserById(userId, folder.workspaceId, dek, cache)

  /* ---------------- same workspace: re-parent and nothing else ------------ */
  if (targetWorkspaceId === folder.workspaceId) {
    if (target.parentId === (folder.parentId ?? null)) {
      return {
        folder,
        crossWorkspace: false,
        rekeyed: false,
        movedFolders: subtree.length - 1,
        movedDocuments: subtreeDocs.length,
        revokedShareTokens: 0,
      }
    }
    const updated = await updateUserFolder(userId, folderId, { parentId: target.parentId }, sourceKey)
    return {
      folder: updated,
      crossWorkspace: false,
      rekeyed: false,
      movedFolders: subtree.length - 1,
      movedDocuments: subtreeDocs.length,
      revokedShareTokens: 0,
    }
  }

  /* ------------------------- cross-workspace move ------------------------ */
  const targetKey = await getWorkspaceKeyForUserById(userId, targetWorkspaceId, dek, cache)
  const rekeyed = !sameKey(sourceKey, targetKey)

  if (rekeyed && (!sourceKey || !targetKey)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'missing_key',
      data: { detail: 'Cannot re-encrypt this folder for the target workspace.' },
    })
  }

  // Decrypt every body up front: `reconcileDocLinks` needs plaintext, and a
  // failure here must abort before anything is written.
  const plainMarkdown = new Map<number, string>()
  try {
    for (const doc of subtreeDocs) {
      plainMarkdown.set(doc.id, decryptField(doc.markdown, sourceKey))
    }
  }
  catch {
    throw createError({
      statusCode: 409,
      statusMessage: 'decrypt_failed',
      data: { detail: 'Folder contents could not be decrypted with the source workspace key.' },
    })
  }

  const [{ maxPosition = -1 } = { maxPosition: -1 }] = await db
    .select({ maxPosition: sql<number>`coalesce(max(${folders.position}), -1)`.mapWith(Number) })
    .from(folders)
    .where(and(
      eq(folders.workspaceId, targetWorkspaceId),
      target.parentId == null ? isNull(folders.parentId) : eq(folders.parentId, target.parentId),
      isNull(folders.deletedAt),
    ))

  const revokedShareTokens = relocateFolderRows({
    rootFolderId: folderId,
    subtreeFolderIds: subtree,
    docIds: subtreeDocs.map(d => d.id),
    targetWorkspaceId,
    targetParentId: target.parentId,
    position: maxPosition + 1,
    oldKey: rekeyed ? sourceKey! : null,
    newKey: rekeyed ? targetKey! : null,
  })

  for (const [docId, markdown] of plainMarkdown) {
    try {
      await reconcileDocLinks(docId, extractDocLinks(markdown, targetWorkspaceId))
    }
    catch (err) {
      console.error('[doc-links] reconcile failed after folder move for doc', docId, err)
    }
  }

  const [moved] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1)
  if (!moved) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }

  return {
    folder: decryptFolder(moved, targetKey),
    crossWorkspace: true,
    rekeyed,
    movedFolders: subtree.length - 1,
    movedDocuments: subtreeDocs.length,
    revokedShareTokens,
  }
}

/* -------------------------------------------------------------------------- */
/*  The transactional half                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Field-level re-encryption closures for one (oldKey -> newKey) pair. When
 * either key is missing the re-key is a no-op, which keeps a single code path
 * for "moved but same key" relocations.
 */
interface Reencryptor {
  /** True when the keys actually differ and content must be rewritten. */
  active: boolean
  field: (s: string | null | undefined) => string
  /** JSON array of strings, encrypted per element (see `encrypted-entities`). */
  list: (raw: string | null) => string
  actionItems: (raw: string | null) => string
}

function makeReencryptor(oldKey: Buffer | null, newKey: Buffer | null): Reencryptor {
  const active = !!oldKey && !!newKey
  const field = (s: string | null | undefined): string => {
    if (s == null) return ''
    if (!active) return s
    if (!isEncrypted(s)) return encryptField(s, newKey!)
    return encryptField(decryptField(s, oldKey!), newKey!)
  }
  const parse = (raw: string | null): unknown[] => {
    try {
      const parsed = JSON.parse(raw ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    }
    catch { return [] }
  }
  return {
    active,
    field,
    list: raw => JSON.stringify(parse(raw).map(s => typeof s === 'string' ? field(s) : s)),
    actionItems: raw => JSON.stringify(parse(raw).map((it) => {
      const item = it as { text?: string, done?: boolean }
      return { text: typeof item.text === 'string' ? field(item.text) : '', done: !!item.done }
    })),
  }
}

/**
 * Re-encrypt everything hanging off a document — versions, analysis, chunks —
 * and revoke its now-unopenable public share links. Caller must already be
 * inside a transaction; the `documents` row itself is handled separately
 * because its other columns differ between a note move and a folder move.
 *
 * Returns the number of share tokens revoked.
 */
function reencryptDocSubrows(
  sqlite: ReturnType<typeof getRawDb>,
  docId: number,
  r: Reencryptor,
  nowSeconds: number,
): number {
  if (!r.active) return 0

  // document_versions — the history travels with the note.
  const versionRows = sqlite.prepare<[number], { id: number, title: string, markdown: string, content_json: string }>(
    `SELECT id, title, markdown, content_json FROM document_versions WHERE doc_id = ?`,
  ).all(docId)
  const updVersion = sqlite.prepare(
    `UPDATE document_versions SET title = ?, markdown = ?, content_json = ? WHERE id = ?`,
  )
  for (const v of versionRows) {
    updVersion.run(r.field(v.title), r.field(v.markdown), r.field(v.content_json), v.id)
  }

  // doc_analyses — JSON-mode columns hold per-element envelopes.
  const analysis = sqlite.prepare<[number], {
    summary_short: string, summary_long: string,
    use_cases: string, tags: string, questions: string, action_items: string,
  }>(
    `SELECT summary_short, summary_long, use_cases, tags, questions, action_items
       FROM doc_analyses WHERE doc_id = ?`,
  ).get(docId)
  if (analysis) {
    sqlite.prepare(
      `UPDATE doc_analyses
          SET summary_short = ?, summary_long = ?, use_cases = ?, tags = ?, questions = ?, action_items = ?
        WHERE doc_id = ?`,
    ).run(
      r.field(analysis.summary_short),
      r.field(analysis.summary_long),
      r.list(analysis.use_cases),
      r.list(analysis.tags),
      r.list(analysis.questions),
      r.actionItems(analysis.action_items),
      docId,
    )
  }

  // doc_chunks.text — embeddings + the FTS5 mirror stay as they are
  // (cleartext by design, and the text itself hasn't changed).
  const chunkRows = sqlite.prepare<[number], { id: number, text: string }>(
    `SELECT id, text FROM doc_chunks WHERE doc_id = ?`,
  ).all(docId)
  const updChunk = sqlite.prepare(`UPDATE doc_chunks SET text = ? WHERE id = ?`)
  for (const c of chunkRows) updChunk.run(r.field(c.text), c.id)

  // Public share links wrap the OLD key under a token we can't recover.
  return sqlite.prepare(
    `UPDATE share_tokens SET revoked_at = ? WHERE doc_id = ? AND revoked_at IS NULL`,
  ).run(nowSeconds, docId).changes
}

/**
 * `doc_links` is workspace-scoped, so drop every row that now straddles two
 * workspaces. Outgoing rows are re-derived by `reconcileDocLinks` once the
 * transaction has committed.
 */
function pruneCrossWorkspaceLinks(
  sqlite: ReturnType<typeof getRawDb>,
  docId: number,
  workspaceId: number,
): void {
  sqlite.prepare(`DELETE FROM doc_links WHERE source_doc_id = ?`).run(docId)
  sqlite.prepare(
    `DELETE FROM doc_links
      WHERE target_doc_id = ?
        AND source_doc_id IN (SELECT id FROM documents WHERE workspace_id <> ?)`,
  ).run(docId, workspaceId)
}

interface RelocateArgs {
  docId: number
  targetWorkspaceId: number
  targetFolderId: number | null
  position: number
  /** Non-null only when the content must be re-encrypted. */
  oldKey: Buffer | null
  newKey: Buffer | null
}

/**
 * Relocate the document row and every content row attached to it, in a single
 * transaction. Mirrors `reencryptWorkspaceContent` in `workspace-share.ts`
 * (same raw-statement approach, scoped to one document) — the query builder
 * has no synchronous transaction wrapper, and this must be all-or-nothing.
 *
 * Returns the number of share tokens revoked.
 */
function relocateDocumentRows(args: RelocateArgs): number {
  const { docId, targetWorkspaceId, targetFolderId, position, oldKey, newKey } = args
  const sqlite = getRawDb()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const r = makeReencryptor(oldKey, newKey)

  let revoked = 0

  const tx = sqlite.transaction(() => {
    const docRow = sqlite.prepare<[number], { title: string, markdown: string, content_json: string }>(
      `SELECT title, markdown, content_json FROM documents WHERE id = ?`,
    ).get(docId)
    if (!docRow) return

    sqlite.prepare(
      `UPDATE documents
          SET workspace_id = ?, folder_id = ?, position = ?, updated_at = ?,
              title = ?, markdown = ?, content_json = ?
        WHERE id = ?`,
    ).run(
      targetWorkspaceId,
      targetFolderId,
      position,
      nowSeconds,
      r.field(docRow.title),
      r.field(docRow.markdown),
      r.field(docRow.content_json),
      docId,
    )

    revoked = reencryptDocSubrows(sqlite, docId, r, nowSeconds)
    pruneCrossWorkspaceLinks(sqlite, docId, targetWorkspaceId)
  })

  tx()
  return revoked
}

interface RelocateFolderArgs {
  rootFolderId: number
  /** Root folder + every descendant, in walk order. */
  subtreeFolderIds: number[]
  docIds: number[]
  targetWorkspaceId: number
  targetParentId: number | null
  position: number
  oldKey: Buffer | null
  newKey: Buffer | null
}

/**
 * Relocate a whole folder subtree in one transaction: folder rows change
 * workspace (the root also changes parent), names and document contents are
 * re-keyed. Inner `parent_id` and `folder_id` links are left alone — ids don't
 * change, so the structure survives the move as-is.
 *
 * Returns the number of share tokens revoked.
 */
function relocateFolderRows(args: RelocateFolderArgs): number {
  const {
    rootFolderId, subtreeFolderIds, docIds,
    targetWorkspaceId, targetParentId, position, oldKey, newKey,
  } = args
  const sqlite = getRawDb()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const r = makeReencryptor(oldKey, newKey)

  let revoked = 0

  const tx = sqlite.transaction(() => {
    const selectFolder = sqlite.prepare<[number], { name: string }>(
      `SELECT name FROM folders WHERE id = ?`,
    )
    const updFolder = sqlite.prepare(
      `UPDATE folders SET workspace_id = ?, name = ? WHERE id = ?`,
    )
    for (const id of subtreeFolderIds) {
      const row = selectFolder.get(id)
      if (!row) continue
      updFolder.run(targetWorkspaceId, r.field(row.name), id)
    }
    // Only the root re-parents; descendants keep pointing at their parent.
    sqlite.prepare(`UPDATE folders SET parent_id = ?, position = ? WHERE id = ?`)
      .run(targetParentId, position, rootFolderId)

    const selectDoc = sqlite.prepare<[number], { title: string, markdown: string, content_json: string }>(
      `SELECT title, markdown, content_json FROM documents WHERE id = ?`,
    )
    const updDoc = sqlite.prepare(
      `UPDATE documents SET workspace_id = ?, title = ?, markdown = ?, content_json = ? WHERE id = ?`,
    )
    for (const docId of docIds) {
      const row = selectDoc.get(docId)
      if (!row) continue
      // `updated_at` is deliberately untouched: the notes themselves weren't
      // edited, and bumping them would reshuffle every "recent" list.
      updDoc.run(
        targetWorkspaceId,
        r.field(row.title),
        r.field(row.markdown),
        r.field(row.content_json),
        docId,
      )
      revoked += reencryptDocSubrows(sqlite, docId, r, nowSeconds)
      pruneCrossWorkspaceLinks(sqlite, docId, targetWorkspaceId)
    }
  })

  tx()
  return revoked
}
