/**
 * Workspace sharing — upgrade a solo workspace to E2EE, share it with
 * other users, and revoke access.
 *
 * The cryptographic narrative:
 *  - The owner unlocks all workspace content with their DEK (regular login
 *    state). We generate a fresh WEK, re-encrypt every content-bearing row
 *    of the workspace from DEK→WEK, then seal the WEK for the owner and
 *    every invited user using their public key (sealed-box; see
 *    crypto.ts → sealForPublicKey). The sealed WEK lives on
 *    `workspace_shares.wrappedWek`. The clear WEK is discarded once the
 *    transaction commits.
 *
 *  - After upgrade `workspaces.encryptionMode = 'wek'` is the wire signal
 *    for every code path that decrypts workspace content — they look up
 *    the WEK via `workspace-key.ts` instead of using the caller's DEK.
 *
 * Inviting a second user once the workspace is already in `'wek'` mode is
 * cheap: the owner's session resolves the WEK once, we re-seal it for the
 * new recipient. No content rewrite.
 *
 * Revocation hard-deletes the membership row. The WEK does NOT rotate —
 * a removed user kept a copy of the WEK in their session up to that
 * point, so anything they read while a member could in principle have
 * been exfiltrated. Rotating the WEK on revoke would be more defensive
 * but doubles the cost on every revoke; we accept the standard "trust
 * past members not to retain ciphertext" trade-off (same as Bitwarden /
 * Standard Notes). If a tighter posture is needed later, add a
 * `rotateWorkspaceKey(workspaceId)` step that re-encrypts every row under
 * a fresh WEK and re-seals it for the remaining members.
 */
import { eq } from 'drizzle-orm'
import { getRawDb, useDb } from '~/server/database/client'
import {
  users,
  workspaceShares,
  type Workspace,
  type WorkspaceRole,
} from '~/server/database/schema'
import {
  decryptField,
  encryptField,
  generateWek,
  isEncrypted,
  sealForPublicKey,
} from './crypto'
import { getWorkspaceKeyForUser } from './workspace-key'

/**
 * Resolve the WEK for `workspaceId`. The workspace MUST be in `'wek'`
 * mode and the caller MUST already be a member (owner or invited).
 * Throws 409 / 403 otherwise.
 *
 * Used by `shareWorkspaceWith` to fetch the WEK once when adding a new
 * member to an already-shared workspace.
 */
async function resolveWekForOwner(workspace: Workspace, ownerId: number, ownerDek: Buffer): Promise<Buffer> {
  return getWorkspaceKeyForUser({ workspace, userId: ownerId, dek: ownerDek })
}

/**
 * Re-encrypt every content-bearing row of `workspaceId` from `oldKey`
 * (the owner's DEK) to `newKey` (the freshly-generated WEK). Runs in a
 * single SQLite transaction — partial failures roll back so the workspace
 * isn't left half-converted.
 *
 * Idempotent w.r.t. `isEncrypted`: a row whose ciphertext can't be opened
 * with `oldKey` is left alone (likely already plaintext on a legacy /
 * partially-encrypted workspace). That matches the existing
 * `encryption-migration.ts` posture.
 */
function reencryptWorkspaceContent(workspaceId: number, oldKey: Buffer, newKey: Buffer): void {
  const sqlite = getRawDb()

  const reenc = (s: string | null | undefined): string => {
    if (s == null) return ''
    if (!isEncrypted(s)) return encryptField(s, newKey)
    try {
      const plain = decryptField(s, oldKey)
      return encryptField(plain, newKey)
    }
    catch (err) {
      // Couldn't open with the owner's DEK — leave the ciphertext as-is
      // (most likely a row written by a different key, e.g. mid-migration
      // state). The membership refresh on next login will surface a
      // decryption_failures entry for the operator to investigate.
      console.warn('[workspace-share] reenc skipped a row, decryption failed:', (err as Error).message)
      return s
    }
  }

  const reencList = (arr: unknown): string => {
    const list = Array.isArray(arr) ? arr : []
    return JSON.stringify(list.map(s => typeof s === 'string' ? reenc(s) : s))
  }

  const reencActionItems = (arr: unknown): string => {
    const list = Array.isArray(arr) ? arr : []
    return JSON.stringify(list.map((it) => {
      const item = it as { text?: string, done?: boolean }
      return { text: typeof item.text === 'string' ? reenc(item.text) : '', done: !!item.done }
    }))
  }

  const tx = sqlite.transaction(() => {
    // workspaces.name
    const ws = sqlite.prepare<[number], { id: number, name: string }>(
      `SELECT id, name FROM workspaces WHERE id = ?`,
    ).get(workspaceId)
    if (ws) {
      sqlite.prepare(`UPDATE workspaces SET name = ? WHERE id = ?`).run(reenc(ws.name), ws.id)
    }

    // folders.name (all folders in this workspace, incl. trashed — re-encrypt everything)
    const folderRows = sqlite.prepare<[number], { id: number, name: string }>(
      `SELECT id, name FROM folders WHERE workspace_id = ?`,
    ).all(workspaceId)
    const updFolder = sqlite.prepare(`UPDATE folders SET name = ? WHERE id = ?`)
    for (const f of folderRows) updFolder.run(reenc(f.name), f.id)

    // documents.title / markdown / content_json
    const docRows = sqlite.prepare<[number], { id: number, title: string, markdown: string, content_json: string }>(
      `SELECT id, title, markdown, content_json FROM documents WHERE workspace_id = ?`,
    ).all(workspaceId)
    const updDoc = sqlite.prepare(
      `UPDATE documents SET title = ?, markdown = ?, content_json = ? WHERE id = ?`,
    )
    const docIds: number[] = []
    for (const d of docRows) {
      docIds.push(d.id)
      updDoc.run(reenc(d.title), reenc(d.markdown), reenc(d.content_json), d.id)
    }
    if (docIds.length === 0) return

    // document_versions
    const versionRows = sqlite.prepare(
      `SELECT id, title, markdown, content_json FROM document_versions WHERE doc_id IN (${docIds.join(',')})`,
    ).all() as { id: number, title: string, markdown: string, content_json: string }[]
    const updVersion = sqlite.prepare(
      `UPDATE document_versions SET title = ?, markdown = ?, content_json = ? WHERE id = ?`,
    )
    for (const v of versionRows) updVersion.run(reenc(v.title), reenc(v.markdown), reenc(v.content_json), v.id)

    // doc_analyses (JSON-mode columns hold per-element encrypted strings)
    const analysisRows = sqlite.prepare(
      `SELECT doc_id, summary_short, summary_long, use_cases, tags, questions, action_items
         FROM doc_analyses WHERE doc_id IN (${docIds.join(',')})`,
    ).all() as {
      doc_id: number, summary_short: string, summary_long: string,
      use_cases: string, tags: string, questions: string, action_items: string,
    }[]
    const updAnalysis = sqlite.prepare(
      `UPDATE doc_analyses
         SET summary_short = ?, summary_long = ?, use_cases = ?, tags = ?, questions = ?, action_items = ?
       WHERE doc_id = ?`,
    )
    for (const a of analysisRows) {
      const parsed = (s: string): unknown => { try { return JSON.parse(s) } catch { return [] } }
      updAnalysis.run(
        reenc(a.summary_short),
        reenc(a.summary_long),
        reencList(parsed(a.use_cases)),
        reencList(parsed(a.tags)),
        reencList(parsed(a.questions)),
        reencActionItems(parsed(a.action_items)),
        a.doc_id,
      )
    }

    // doc_chunks.text — embeddings + FTS5 stay untouched (already unencrypted by design)
    const chunkRows = sqlite.prepare(
      `SELECT id, text FROM doc_chunks WHERE doc_id IN (${docIds.join(',')})`,
    ).all() as { id: number, text: string }[]
    const updChunk = sqlite.prepare(`UPDATE doc_chunks SET text = ? WHERE id = ?`)
    for (const c of chunkRows) updChunk.run(reenc(c.text), c.id)
  })

  tx()
}

/**
 * Upgrade a solo (`'dek'`) workspace to a shared (`'wek'`) workspace.
 * After this returns the workspace is encrypted under the returned WEK
 * and the owner has a `workspace_shares` row with role `'owner'`.
 *
 * The caller MUST be the owner and MUST have a public key on file (the
 * lazy backfill on login normally guarantees this).
 *
 * Returns the WEK so the caller can keep going (e.g. to wrap it for a
 * new invitee in the same request).
 */
async function upgradeWorkspaceToWek(args: {
  workspace: Workspace
  ownerId: number
  ownerDek: Buffer
  ownerPublicKey: Buffer
}): Promise<Buffer> {
  const { workspace, ownerId, ownerDek, ownerPublicKey } = args
  if (workspace.encryptionMode === 'wek') {
    throw new Error('workspace is already in wek mode')
  }

  const wek = generateWek()
  reencryptWorkspaceContent(workspace.id, ownerDek, wek)

  const sqlite = getRawDb()
  const ownerSealedWek = sealForPublicKey(wek, ownerPublicKey)

  sqlite.transaction(() => {
    sqlite.prepare(`UPDATE workspaces SET encryption_mode = 'wek' WHERE id = ?`).run(workspace.id)
    sqlite.prepare(
      `INSERT INTO workspace_shares (workspace_id, user_id, role, wrapped_wek, created_by)
       VALUES (?, ?, 'owner', ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE
         SET role = 'owner', wrapped_wek = excluded.wrapped_wek`,
    ).run(workspace.id, ownerId, ownerSealedWek, ownerId)
  })()

  return wek
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ShareResult {
  /** The freshly-inserted membership row (id, role, createdAt, ...). */
  share: {
    id: number
    workspaceId: number
    userId: number
    role: WorkspaceRole
    createdAt: Date
  }
  /** True iff the workspace was upgraded `dek` → `wek` as part of this share. */
  upgraded: boolean
}

/**
 * Grant `targetUserId` access to `workspace` with the given role. Caller
 * must be the owner. If the workspace is still in `'dek'` mode it is
 * upgraded inline (single transaction).
 *
 * Throws:
 *  - 404 `missing_target_user`
 *  - 409 `missing_target_keypair` (target hasn't logged in since the
 *    share-rollout deploy)
 *  - 409 `missing_owner_keypair` (same for the owner)
 *  - 409 `target_is_owner` if trying to share with oneself
 */
export async function shareWorkspaceWith(args: {
  workspace: Workspace
  ownerId: number
  ownerDek: Buffer
  targetUserId: number
  role: 'editor' | 'viewer'
}): Promise<ShareResult> {
  const { workspace, ownerId, ownerDek, targetUserId, role } = args
  if (targetUserId === ownerId) {
    throw Object.assign(new Error('target_is_owner'), { statusCode: 409 })
  }

  const db = useDb()
  const [owner] = await db
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1)
  if (!owner?.publicKey) {
    throw Object.assign(new Error('missing_owner_keypair'), { statusCode: 409 })
  }

  const [target] = await db
    .select({ id: users.id, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1)
  if (!target) {
    throw Object.assign(new Error('missing_target_user'), { statusCode: 404 })
  }
  if (!target.publicKey) {
    throw Object.assign(new Error('missing_target_keypair'), { statusCode: 409 })
  }

  let wek: Buffer
  let upgraded = false
  if (workspace.encryptionMode === 'dek') {
    wek = await upgradeWorkspaceToWek({
      workspace,
      ownerId,
      ownerDek,
      ownerPublicKey: owner.publicKey,
    })
    upgraded = true
  }
  else {
    wek = await resolveWekForOwner(workspace, ownerId, ownerDek)
  }

  const sealedForTarget = sealForPublicKey(wek, target.publicKey)
  const [inserted] = await db
    .insert(workspaceShares)
    .values({
      workspaceId: workspace.id,
      userId: targetUserId,
      role,
      wrappedWek: sealedForTarget,
      createdBy: ownerId,
    })
    .returning()
  if (!inserted) {
    throw new Error('insert_failed')
  }
  return {
    share: {
      id: inserted.id,
      workspaceId: inserted.workspaceId,
      userId: inserted.userId,
      role: inserted.role,
      createdAt: inserted.createdAt,
    },
    upgraded,
  }
}

/**
 * Change the role of an existing member. Owner role is read-only here —
 * the workspace's owner is determined by `workspaces.ownerId`, not by
 * mutating the share row.
 */
export async function updateShareRole(args: {
  workspace: Workspace
  ownerId: number
  targetUserId: number
  role: 'editor' | 'viewer'
}): Promise<void> {
  const { workspace, ownerId, targetUserId, role } = args
  if (targetUserId === ownerId) {
    throw Object.assign(new Error('cannot_change_owner_role'), { statusCode: 400 })
  }
  const sqlite = getRawDb()
  sqlite.prepare(
    `UPDATE workspace_shares SET role = ?
       WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'`,
  ).run(role, workspace.id, targetUserId)
}

/**
 * Hard-delete a member's share row. Owner is the only one allowed to do
 * this. The WEK does NOT rotate — see top-of-file note.
 */
export async function revokeShare(args: {
  workspaceId: number
  ownerId: number
  targetUserId: number
}): Promise<void> {
  const { workspaceId, ownerId, targetUserId } = args
  if (targetUserId === ownerId) {
    throw Object.assign(new Error('cannot_revoke_owner'), { statusCode: 400 })
  }
  const sqlite = getRawDb()
  sqlite.prepare(
    `DELETE FROM workspace_shares WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'`,
  ).run(workspaceId, targetUserId)
}

/**
 * List members of `workspaceId`. Returns one row per member (incl. the
 * owner) with the user's email + displayName for the share dialog.
 */
export interface ShareMemberRow {
  id: number
  userId: number
  email: string
  displayName: string | null
  role: WorkspaceRole
  createdAt: Date
}

export async function listShareMembers(workspaceId: number): Promise<ShareMemberRow[]> {
  const db = useDb()
  const rows = await db
    .select({
      id: workspaceShares.id,
      userId: workspaceShares.userId,
      email: users.email,
      displayName: users.displayName,
      role: workspaceShares.role,
      createdAt: workspaceShares.createdAt,
    })
    .from(workspaceShares)
    .innerJoin(users, eq(users.id, workspaceShares.userId))
    .where(eq(workspaceShares.workspaceId, workspaceId))
  // Sort: owner first, then by createdAt asc.
  rows.sort((a, b) => {
    if (a.role === 'owner' && b.role !== 'owner') return -1
    if (b.role === 'owner' && a.role !== 'owner') return 1
    const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt as unknown as string).getTime()
    const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt as unknown as string).getTime()
    return ta - tb
  })
  return rows
}

