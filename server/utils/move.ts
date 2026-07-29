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
import { and, eq, isNull, sql } from 'drizzle-orm'
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
  assertWorkspaceMembership,
} from './access'
import { decryptField, encryptField, isEncrypted } from './crypto'
import { extractDocLinks, reconcileDocLinks } from './doc-links'
import { decryptDocument } from './encrypted-entities'
import { updateUserDocument } from './notes'
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
/*  The transactional half                                                     */
/* -------------------------------------------------------------------------- */

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

  // No re-key => identity. Keeps a single code path for both cases.
  const reenc = (s: string | null | undefined): string => {
    if (s == null) return ''
    if (!oldKey || !newKey) return s
    if (!isEncrypted(s)) return encryptField(s, newKey)
    return encryptField(decryptField(s, oldKey), newKey)
  }
  const reencList = (raw: string | null): string => {
    let list: unknown = []
    try { list = JSON.parse(raw ?? '[]') }
    catch { list = [] }
    const arr = Array.isArray(list) ? list : []
    return JSON.stringify(arr.map(s => typeof s === 'string' ? reenc(s) : s))
  }
  const reencActionItems = (raw: string | null): string => {
    let list: unknown = []
    try { list = JSON.parse(raw ?? '[]') }
    catch { list = [] }
    const arr = Array.isArray(list) ? list : []
    return JSON.stringify(arr.map((it) => {
      const item = it as { text?: string, done?: boolean }
      return { text: typeof item.text === 'string' ? reenc(item.text) : '', done: !!item.done }
    }))
  }

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
      reenc(docRow.title),
      reenc(docRow.markdown),
      reenc(docRow.content_json),
      docId,
    )

    if (oldKey && newKey) {
      // document_versions — the history moves with the note.
      const versionRows = sqlite.prepare<[number], { id: number, title: string, markdown: string, content_json: string }>(
        `SELECT id, title, markdown, content_json FROM document_versions WHERE doc_id = ?`,
      ).all(docId)
      const updVersion = sqlite.prepare(
        `UPDATE document_versions SET title = ?, markdown = ?, content_json = ? WHERE id = ?`,
      )
      for (const v of versionRows) {
        updVersion.run(reenc(v.title), reenc(v.markdown), reenc(v.content_json), v.id)
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
          reenc(analysis.summary_short),
          reenc(analysis.summary_long),
          reencList(analysis.use_cases),
          reencList(analysis.tags),
          reencList(analysis.questions),
          reencActionItems(analysis.action_items),
          docId,
        )
      }

      // doc_chunks.text — embeddings + the FTS5 mirror stay as they are
      // (cleartext by design, and the text itself hasn't changed).
      const chunkRows = sqlite.prepare<[number], { id: number, text: string }>(
        `SELECT id, text FROM doc_chunks WHERE doc_id = ?`,
      ).all(docId)
      const updChunk = sqlite.prepare(`UPDATE doc_chunks SET text = ? WHERE id = ?`)
      for (const c of chunkRows) updChunk.run(reenc(c.text), c.id)

      // Public share links wrap the OLD key under a token we can't recover.
      const res = sqlite.prepare(
        `UPDATE share_tokens SET revoked_at = ? WHERE doc_id = ? AND revoked_at IS NULL`,
      ).run(nowSeconds, docId)
      revoked = res.changes
    }

    // doc_links is workspace-scoped: drop everything that now straddles two
    // workspaces. Outgoing rows are re-derived by `reconcileDocLinks` right
    // after the transaction.
    sqlite.prepare(`DELETE FROM doc_links WHERE source_doc_id = ?`).run(docId)
    sqlite.prepare(
      `DELETE FROM doc_links
        WHERE target_doc_id = ?
          AND source_doc_id IN (SELECT id FROM documents WHERE workspace_id <> ?)`,
    ).run(docId, targetWorkspaceId)
  })

  tx()
  return revoked
}
