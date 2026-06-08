/**
 * Notes service layer — user-scoped operations shared by the REST API
 * endpoints AND the MCP server. Single source of truth: each business
 * operation lives here once and is consumed by both transports.
 *
 * All functions:
 *   - take a numeric `userId` (REST resolves it via `requireUser`, MCP via
 *     `requireMcpUser`),
 *   - perform ownership checks via `assert*Ownership` from `access.ts`,
 *   - apply the soft-delete convention via `activeDocsWhere()` /
 *     `activeFoldersWhere()` on LIST reads (lookup-by-id intentionally does
 *     not — see `server/utils/active.ts`),
 *   - throw H3 errors (`createError({ statusCode, statusMessage })`) on
 *     validation / authz / not-found.
 *
 * Soft-delete rule for new readers: any tool/endpoint exposing notes to
 * external clients (MCP, REST list endpoints) MUST filter trashed rows.
 * The corresponding mutation primitives below (`softDelete*`) match the
 * legacy REST cascade exactly (shared `deletedAt` timestamp across a
 * folder's subtree so restore can re-hydrate the same group).
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { createError } from 'h3'
import { z } from 'zod'
import { useDb } from '~/server/database/client'
import {
  docAnalyses,
  docLinks,
  documents,
  documentVersions,
  folders,
  workspaces,
  workspaceShares,
  type DocAnalysis,
  type Document,
  type Folder,
  type Workspace,
  type WorkspaceRole,
} from '~/server/database/schema'
import { getWorkspaceKeyForUser, type WorkspaceKeyCache } from './workspace-key'
import {
  assertCanEdit,
  assertDocumentMembership,
  assertDocumentOwnership,
  assertFolderMembership,
  assertFolderOwnership,
  assertWorkspaceMembership,
  assertWorkspaceOwnership,
} from './access'
import { activeDocsWhere, activeFoldersWhere } from './active'
import { embedDocument } from './embed-doc'
import { extractDocLinks, reconcileDocLinks } from './doc-links'
import { mistralChat, mistralEmbed } from './mistral'
import { floatsToBuffer } from './vector'
import { searchChunkGroups, type SearchChunkGroup, type SearchHit } from './search'
import { scoreTitleMatch, TITLE_MATCH_MIN_SCORE } from './title-match'
import { decryptField } from './crypto'
import {
  decryptAnalysis,
  decryptDocument,
  decryptFolder,
  decryptWorkspace,
  encryptAnalysis,
  encryptDocument,
  encryptDocumentVersion,
  encryptFolder,
  encryptWorkspace,
} from './encrypted-entities'

/**
 * Encryption note — every entity touched by these functions carries
 * user-authored content. Inputs to this service are PLAINTEXT (callers
 * pass titles/markdown/etc. as the user typed them); the service encrypts
 * before writing and decrypts before returning. Pass the per-user DEK as
 * the last argument; `null` is a transparent no-op (legacy/pre-migration
 * users, and the small set of callers that intentionally don't need
 * plaintext).
 *
 * See [server/utils/crypto.ts](server/utils/crypto.ts) and
 * [server/utils/encrypted-entities.ts](server/utils/encrypted-entities.ts).
 */

/* ========================================================================== */
/*  Workspaces                                                                 */
/* ========================================================================== */

export interface WorkspaceListItem extends Workspace {
  /** Caller's role on this workspace — `'owner'` for solo + owned-shared, `'editor'`/`'viewer'` for invited members. */
  role: WorkspaceRole
  /** True when the workspace is shared with at least one other user. */
  shared: boolean
}

/**
 * Resolve the content key for one workspace inside a multi-workspace sweep
 * (overview / find / cross-workspace search): DEK for solo workspaces, WEK
 * for shared ones. A failed WEK unwrap downgrades to `null` (titles stay as
 * raw envelopes) instead of failing the whole sweep — one broken share must
 * not take down the other workspaces. Targeted single-entity operations use
 * `getWorkspaceKeyForUserById` instead, which throws.
 */
async function resolveContentKey(
  workspace: Workspace,
  userId: number,
  dek: Buffer | null,
  cache: WorkspaceKeyCache,
): Promise<Buffer | null> {
  if (!dek) return null
  if (workspace.encryptionMode !== 'wek') return dek
  try {
    return await getWorkspaceKeyForUser({ workspace, userId, dek, cache })
  }
  catch (err) {
    console.error('[notes] WEK resolve failed for workspace', workspace.id, err)
    return null
  }
}

/**
 * List every workspace the user has access to (owned + shared). Each row
 * decrypts under its own key:
 *  - solo workspaces (mode `'dek'`): the caller is the owner, so its
 *    name is encrypted under their DEK.
 *  - shared workspaces (mode `'wek'`): unseal the WEK from the caller's
 *    `workspace_shares` row, then decrypt the name with it.
 *
 * Without a DEK on the session (legacy/pre-encryption), we fall through
 * `decryptWorkspace` unchanged.
 */
export async function listUserWorkspaces(userId: number, dek: Buffer | null = null): Promise<WorkspaceListItem[]> {
  const db = useDb()
  const owned = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId))
    .orderBy(desc(workspaces.createdAt))

  const sharedRows = await db
    .select({ workspace: workspaces, role: workspaceShares.role })
    .from(workspaceShares)
    .innerJoin(workspaces, eq(workspaces.id, workspaceShares.workspaceId))
    .where(eq(workspaceShares.userId, userId))
    .orderBy(desc(workspaces.createdAt))

  // Owner of a shared workspace appears in BOTH lists — dedupe by id.
  // Prefer the `workspace_shares` row for the role (always `'owner'` for
  // owners of upgraded workspaces; keeps the lookup uniform).
  const byId = new Map<number, { workspace: Workspace, role: WorkspaceRole }>()
  for (const w of owned) byId.set(w.id, { workspace: w, role: 'owner' })
  for (const s of sharedRows) byId.set(s.workspace.id, { workspace: s.workspace, role: s.role })

  // Which `'wek'` workspaces have more than one member — used to flag the
  // `shared` indicator in the UI without an N+1.
  const wekIds = [...byId.values()].filter(v => v.workspace.encryptionMode === 'wek').map(v => v.workspace.id)
  const memberCounts = wekIds.length > 0
    ? await db
      .select({ workspaceId: workspaceShares.workspaceId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(workspaceShares)
      .where(inArray(workspaceShares.workspaceId, wekIds))
      .groupBy(workspaceShares.workspaceId)
    : []
  const memberCountByWs = new Map(memberCounts.map(m => [m.workspaceId, m.n]))

  const keyCache: WorkspaceKeyCache = {}
  const out: WorkspaceListItem[] = []
  for (const { workspace, role } of byId.values()) {
    const key = await resolveContentKey(workspace, userId, dek, keyCache)
    const decrypted = decryptWorkspace(workspace, key)
    out.push({
      ...decrypted,
      role,
      shared: (memberCountByWs.get(workspace.id) ?? 0) > 1,
    })
  }
  // Stable order: newest first.
  out.sort((a, b) => {
    const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt as unknown as string).getTime()
    const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt as unknown as string).getTime()
    return tb - ta
  })
  return out
}

export interface WorkspaceDetail {
  workspace: Workspace
  folders: Folder[]
  counts: { rootDocuments: number, totalDocuments: number }
}

export async function getUserWorkspace(
  userId: number,
  workspaceId: number,
  dek: Buffer | null = null,
): Promise<WorkspaceDetail> {
  const workspace = decryptWorkspace(await assertWorkspaceOwnership(userId, workspaceId), dek)
  const db = useDb()

  const folderRows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.workspaceId, workspace.id), activeFoldersWhere()))
    .orderBy(asc(folders.position), asc(folders.id))

  const [{ count: rootDocCount = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(documents)
    .where(and(
      eq(documents.workspaceId, workspace.id),
      isNull(documents.folderId),
      activeDocsWhere(),
    ))

  const [{ count: totalDocCount = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspace.id), activeDocsWhere()))

  return {
    workspace,
    folders: folderRows.map(f => decryptFolder(f, dek)),
    counts: { rootDocuments: rootDocCount, totalDocuments: totalDocCount },
  }
}

/* ========================================================================== */
/*  Documents                                                                  */
/* ========================================================================== */

export type DocumentListRow = {
  id: number
  workspaceId: number
  folderId: number | null
  title: string
  position: number
  createdAt: Date
  updatedAt: Date
}

export interface ListDocumentsOptions {
  /** `'root'` filters to documents with `folderId IS NULL`; numeric id filters
   *  to that folder; omitted/undefined returns all docs in the workspace. */
  folderId?: number | 'root'
}

export async function listUserDocuments(
  userId: number,
  workspaceId: number,
  options: ListDocumentsOptions = {},
  dek: Buffer | null = null,
): Promise<DocumentListRow[]> {
  const workspace = await assertWorkspaceOwnership(userId, workspaceId)
  const conditions: SQL[] = [eq(documents.workspaceId, workspace.id), activeDocsWhere()]

  if (options.folderId === 'root') {
    conditions.push(isNull(documents.folderId))
  }
  else if (typeof options.folderId === 'number') {
    const folder = await assertFolderOwnership(userId, options.folderId)
    if (folder.workspaceId !== workspace.id) {
      // Forces empty result rather than throwing — matches the REST behaviour
      // of returning an empty list when the folder belongs to another
      // workspace (auth check already covered ownership above).
      conditions.push(eq(documents.folderId, -1))
    }
    else {
      conditions.push(eq(documents.folderId, options.folderId))
    }
  }

  const db = useDb()
  const rows = await db
    .select({
      id: documents.id,
      workspaceId: documents.workspaceId,
      folderId: documents.folderId,
      title: documents.title,
      position: documents.position,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(...conditions))
    .orderBy(asc(documents.position), asc(documents.id))
  return rows.map(r => decryptDocument(r, dek))
}

export interface DocumentWithAnalysis {
  document: Document
  analysis: DocAnalysis | null
}

/**
 * Read a single document by id. The `includeTrashed` flag controls whether a
 * soft-deleted document raises 404 — the REST endpoint returns trashed docs
 * (the trash UI needs them) but MCP read tools pass `includeTrashed: false`
 * so external clients never see deleted content.
 */
export async function getUserDocument(
  userId: number,
  docId: number,
  { includeTrashed = true }: { includeTrashed?: boolean } = {},
  dek: Buffer | null = null,
): Promise<DocumentWithAnalysis> {
  const document = await assertDocumentOwnership(userId, docId)
  if (!includeTrashed && document.deletedAt != null) {
    throw createError({ statusCode: 404, statusMessage: 'Document is in trash' })
  }
  const db = useDb()
  const [analysis] = await db
    .select()
    .from(docAnalyses)
    .where(eq(docAnalyses.docId, docId))
    .limit(1)
  return {
    document: decryptDocument(document, dek),
    analysis: analysis ? decryptAnalysis(analysis, dek) : null,
  }
}

export interface CreateDocumentInput {
  workspaceId: number
  folderId?: number | null
  title?: string
  markdown?: string
  contentJson?: string
  position?: number
}

export async function createUserDocument(
  userId: number,
  input: CreateDocumentInput,
  dek: Buffer | null = null,
): Promise<Document> {
  const { workspace, role } = await assertWorkspaceMembership(userId, input.workspaceId)
  assertCanEdit(role)

  if (input.folderId != null) {
    const folder = await assertFolderOwnership(userId, input.folderId)
    if (folder.workspaceId !== workspace.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Folder must belong to the same workspace',
      })
    }
  }

  const db = useDb()
  const now = new Date()
  const plainTitle = input.title ?? 'Untitled'
  const plainMarkdown = input.markdown ?? ''
  const plainContentJson = input.contentJson ?? '{}'
  const encrypted = encryptDocument(
    { title: plainTitle, markdown: plainMarkdown, contentJson: plainContentJson },
    dek,
  )
  const [created] = await db
    .insert(documents)
    .values({
      workspaceId: workspace.id,
      folderId: input.folderId ?? null,
      title: encrypted.title!,
      markdown: encrypted.markdown!,
      contentJson: encrypted.contentJson!,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create document' })
  }

  // Keep doc_links in sync when seeding markdown — wiki-style links may
  // already be present at create time (e.g. from a templating tool).
  // extractDocLinks needs PLAINTEXT, so use the input string (`plainMarkdown`),
  // not what we just wrote to the DB.
  if (plainMarkdown.length > 0) {
    try {
      const targets = extractDocLinks(plainMarkdown, created.workspaceId)
      await reconcileDocLinks(created.id, targets)
    }
    catch (err) {
      console.error('[doc-links] reconcile failed on create for doc', created.id, err)
    }
  }

  return decryptDocument(created, dek)
}

export interface UpdateDocumentInput {
  title?: string
  markdown?: string
  contentJson?: string
  folderId?: number | null
  position?: number
}

/** Sprint 5 / I9 — edit-session window. A snapshot is taken on the first
 *  content-bearing update that arrives after this many ms have elapsed since
 *  the most-recent existing snapshot for the doc. */
const SNAPSHOT_WINDOW_MS = 30 * 60 * 1000

export async function updateUserDocument(
  userId: number,
  docId: number,
  input: UpdateDocumentInput,
  dek: Buffer | null = null,
): Promise<Document> {
  const { document: doc, role } = await assertDocumentMembership(userId, docId)
  assertCanEdit(role)
  if (doc.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: 'Document is in trash' })
  }

  if (input.folderId !== undefined && input.position !== undefined) {
    throw createError({
      statusCode: 400,
      statusMessage: 'folderId and position cannot be updated in the same request',
    })
  }

  if (input.folderId !== undefined && input.folderId !== null) {
    const folder = await assertFolderOwnership(userId, input.folderId)
    if (folder.workspaceId !== doc.workspaceId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Folder must belong to the same workspace',
      })
    }
  }

  // Build ciphertext patch — `input.*` is plaintext, so wrap each field.
  const encryptedPatch = encryptDocument(
    {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
      ...(input.contentJson !== undefined ? { contentJson: input.contentJson } : {}),
    },
    dek,
  )
  const patch: Partial<typeof documents.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (encryptedPatch.title !== undefined) patch.title = encryptedPatch.title
  if (encryptedPatch.markdown !== undefined) patch.markdown = encryptedPatch.markdown
  if (encryptedPatch.contentJson !== undefined) patch.contentJson = encryptedPatch.contentJson
  if (input.folderId !== undefined) patch.folderId = input.folderId
  if (input.position !== undefined) patch.position = input.position

  const db = useDb()

  // Version snapshot policy (Sprint 5 / I9): snapshot on content-bearing
  // updates (title / markdown / contentJson) when the previous snapshot is
  // either missing or older than SNAPSHOT_WINDOW_MS. Pure moves / reorders
  // are skipped (they would just be timeline noise). Failure here must
  // NEVER block the save itself.
  //
  // The `doc.*` fields fetched from the DB are already ciphertext when the
  // user is encrypted — pass them straight to documentVersions (no
  // double-encryption). For legacy plaintext rows we encrypt before
  // snapshotting so the snapshot inherits the current at-rest format.
  const isContentChange = (
    input.title !== undefined
    || input.markdown !== undefined
    || input.contentJson !== undefined
  )
  if (isContentChange) {
    try {
      const [latest] = await db
        .select({ createdAt: documentVersions.createdAt })
        .from(documentVersions)
        .where(eq(documentVersions.docId, docId))
        .orderBy(desc(documentVersions.createdAt))
        .limit(1)

      const now = Date.now()
      const latestMs = latest?.createdAt
        ? (latest.createdAt instanceof Date
            ? latest.createdAt.getTime()
            : new Date(latest.createdAt as unknown as string).getTime())
        : null
      const shouldSnapshot = latestMs === null || (now - latestMs) >= SNAPSHOT_WINDOW_MS

      if (shouldSnapshot) {
        // The prior doc fields may be plaintext (legacy) or ciphertext.
        // `encryptDocumentVersion` is idempotent — `encryptField` short-
        // circuits on values already in envelope form.
        const snapshot = encryptDocumentVersion(
          { title: doc.title, markdown: doc.markdown, contentJson: doc.contentJson },
          dek,
        )
        await db.insert(documentVersions).values({
          docId: doc.id,
          markdown: snapshot.markdown!,
          contentJson: snapshot.contentJson!,
          title: snapshot.title!,
          createdBy: userId,
          reason: 'autosave_snapshot',
        })
      }
    }
    catch (err) {
      console.error('[doc-versions] snapshot failed for doc', docId, err)
    }
  }

  const [updated] = await db
    .update(documents)
    .set(patch)
    .where(eq(documents.id, docId))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }

  if (input.markdown !== undefined) {
    try {
      const targets = extractDocLinks(input.markdown, updated.workspaceId)
      await reconcileDocLinks(updated.id, targets)
    }
    catch (err) {
      console.error('[doc-links] reconcile failed for doc', updated.id, err)
    }
  }

  return decryptDocument(updated, dek)
}

/**
 * Soft-delete a document — idempotent. Matches `documents/[id].delete.ts`:
 * stamps `deletedAt = now()` if the row is currently active; if already
 * trashed, returns the existing timestamp.
 */
export async function softDeleteUserDocument(
  userId: number,
  docId: number,
): Promise<{ ok: true, deletedAt: Date }> {
  const { document: doc, role } = await assertDocumentMembership(userId, docId)
  assertCanEdit(role)
  if (doc.deletedAt != null) {
    return { ok: true, deletedAt: doc.deletedAt }
  }
  const db = useDb()
  const now = new Date()
  const [updated] = await db
    .update(documents)
    .set({ deletedAt: now })
    .where(and(eq(documents.id, docId), isNull(documents.deletedAt)))
    .returning({ deletedAt: documents.deletedAt })

  if (!updated || !updated.deletedAt) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }
  return { ok: true, deletedAt: updated.deletedAt }
}

/* ========================================================================== */
/*  Folders                                                                    */
/* ========================================================================== */

export interface CreateFolderInput {
  workspaceId: number
  parentId?: number | null
  name: string
  position?: number
}

export async function createUserFolder(
  userId: number,
  input: CreateFolderInput,
  dek: Buffer | null = null,
): Promise<Folder> {
  const { workspace, role } = await assertWorkspaceMembership(userId, input.workspaceId)
  assertCanEdit(role)

  if (input.parentId != null) {
    const parent = await assertFolderOwnership(userId, input.parentId)
    if (parent.workspaceId !== workspace.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Parent folder must belong to the same workspace',
      })
    }
  }

  const db = useDb()
  const encryptedName = encryptFolder({ name: input.name }, dek).name!
  const [created] = await db
    .insert(folders)
    .values({
      workspaceId: workspace.id,
      parentId: input.parentId ?? null,
      name: encryptedName,
      position: input.position ?? 0,
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create folder' })
  }
  return decryptFolder(created, dek)
}

export interface UpdateFolderInput {
  name?: string
  parentId?: number | null
  position?: number
}

export async function updateUserFolder(
  userId: number,
  folderId: number,
  input: UpdateFolderInput,
  dek: Buffer | null = null,
): Promise<Folder> {
  const { folder, role } = await assertFolderMembership(userId, folderId)
  assertCanEdit(role)

  if (input.parentId !== undefined && input.position !== undefined) {
    throw createError({
      statusCode: 400,
      statusMessage: 'parentId and position cannot be updated in the same request',
    })
  }

  const db = useDb()

  if (input.parentId !== undefined && input.parentId !== null) {
    if (input.parentId === folderId) {
      throw createError({ statusCode: 400, statusMessage: 'Folder cannot be its own parent' })
    }
    const parent = await assertFolderOwnership(userId, input.parentId)
    if (parent.workspaceId !== folder.workspaceId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Parent folder must belong to the same workspace',
      })
    }
    let cursor: number | null = parent.parentId
    let safety = 0
    while (cursor !== null && safety < 1000) {
      if (cursor === folderId) {
        throw createError({ statusCode: 400, statusMessage: 'Cannot move folder into its descendant' })
      }
      const [next] = await db.select().from(folders).where(eq(folders.id, cursor)).limit(1)
      cursor = next?.parentId ?? null
      safety++
    }
  }

  const patch: Partial<typeof folders.$inferInsert> = {}
  if (input.name !== undefined) patch.name = encryptFolder({ name: input.name }, dek).name!
  if (input.parentId !== undefined) patch.parentId = input.parentId
  if (input.position !== undefined) patch.position = input.position

  const [updated] = await db.update(folders).set(patch).where(eq(folders.id, folderId)).returning()
  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }
  return decryptFolder(updated, dek)
}

async function collectActiveSubtreeFolderIds(rootId: number): Promise<number[]> {
  const db = useDb()
  const collected = new Set<number>([rootId])
  let frontier: number[] = [rootId]
  while (frontier.length > 0) {
    const children = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(inArray(folders.parentId, frontier), isNull(folders.deletedAt)))
    const next: number[] = []
    for (const c of children) {
      if (!collected.has(c.id)) {
        collected.add(c.id)
        next.push(c.id)
      }
    }
    frontier = next
  }
  return [...collected]
}

/**
 * Soft-delete a folder and its entire active subtree (folders + documents)
 * with a SHARED `deletedAt` timestamp. The restore endpoint relies on the
 * shared timestamp to re-hydrate the same group of items.
 *
 * Idempotent: a re-call on an already-trashed folder returns the existing
 * timestamp without touching descendants.
 */
export async function softDeleteUserFolder(
  userId: number,
  folderId: number,
): Promise<{ ok: true, deletedAt: Date }> {
  const { folder, role } = await assertFolderMembership(userId, folderId)
  assertCanEdit(role)
  if (folder.deletedAt != null) {
    return { ok: true, deletedAt: folder.deletedAt }
  }

  const db = useDb()
  const now = new Date()
  const allFolderIds = await collectActiveSubtreeFolderIds(folderId)

  await db
    .update(folders)
    .set({ deletedAt: now })
    .where(and(inArray(folders.id, allFolderIds), isNull(folders.deletedAt)))

  await db
    .update(documents)
    .set({ deletedAt: now })
    .where(and(inArray(documents.folderId, allFolderIds), isNull(documents.deletedAt)))

  return { ok: true, deletedAt: now }
}

/* ========================================================================== */
/*  Search (workspace-scoped RAG)                                              */
/* ========================================================================== */

export interface SearchResult {
  docId: number
  title: string
  chunkIdx: number
  /** Full chunk text (trimmed). */
  snippet: string
  /** Best-matching sentence inside the chunk relative to the query. */
  highlight: string
  /** Final relevance score in [0, 1]. */
  score: number
}

export interface WorkspaceSearchResult extends SearchResult {
  workspaceId: number
  workspaceName: string
}

/**
 * Narrow the caller's workspaces to a target scope. `workspaceId`
 * undefined = every workspace the user can access. An id the user can't
 * access surfaces the canonical 404/403 from the ownership check rather
 * than a silent empty result.
 */
async function scopeWorkspaces(
  userId: number,
  workspaceId: number | undefined,
  dek: Buffer | null,
): Promise<WorkspaceListItem[]> {
  const all = await listUserWorkspaces(userId, dek)
  if (workspaceId == null) return all
  const hit = all.find(w => w.id === workspaceId)
  if (hit) return [hit]
  await assertWorkspaceOwnership(userId, workspaceId)
  return []
}

/**
 * Semantic search across the user's notes — one workspace when
 * `workspaceId` is given, ALL accessible workspaces otherwise. Skips
 * trashed docs. One Mistral embed + one rerank round-trip total,
 * regardless of workspace count (see `searchChunkGroups`).
 *
 * Used by the `search_notes` MCP tool. The chat endpoint runs the same
 * retrieval internally (via `rankChunks`) — keeping both behind shared
 * primitives means tuning one parameter (e.g. MIN_SCORE) takes effect in
 * both.
 */
export async function searchUserNotes(
  userId: number,
  query: string,
  options: { workspaceId?: number } = {},
  dek: Buffer | null = null,
): Promise<WorkspaceSearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  const scoped = await scopeWorkspaces(userId, options.workspaceId, dek)
  if (scoped.length === 0) return []

  const db = useDb()
  const keyCache: WorkspaceKeyCache = {}
  const groups: SearchChunkGroup[] = []
  const titleByDoc = new Map<number, string>()
  const workspaceByDoc = new Map<number, { id: number, name: string }>()

  for (const ws of scoped) {
    // `ws` comes out of listUserWorkspaces already decrypted — only the
    // per-doc titles still need the workspace's content key.
    const key = await resolveContentKey(ws, userId, dek, keyCache)
    const candidateDocs = await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(eq(documents.workspaceId, ws.id), activeDocsWhere()))
    if (candidateDocs.length === 0) continue
    for (const d of candidateDocs) {
      titleByDoc.set(d.id, decryptDocument({ title: d.title }, key).title ?? 'Untitled')
      workspaceByDoc.set(d.id, { id: ws.id, name: ws.name })
    }
    groups.push({ docIds: candidateDocs.map(d => d.id), key })
  }
  if (groups.length === 0) return []

  // `searchChunkGroups` returns snippets/highlights derived from the
  // already-decrypted chunk text (see search.ts), so we don't need to
  // decrypt the hit fields here.
  const hits: SearchHit[] = await searchChunkGroups(groups, trimmed)

  return hits.map((h) => {
    const ws = workspaceByDoc.get(h.docId)
    return {
      docId: h.docId,
      title: titleByDoc.get(h.docId) ?? 'Untitled',
      chunkIdx: h.idx,
      snippet: h.snippet,
      highlight: h.highlight,
      score: h.score,
      workspaceId: ws?.id ?? 0,
      workspaceName: ws?.name ?? '',
    }
  })
}

/* ========================================================================== */
/*  Overview / find / append / tags / links (MCP round-trip reducers)          */
/* ========================================================================== */

export interface OverviewFolder {
  id: number
  name: string
  parentId: number | null
}

export interface OverviewDocument {
  id: number
  title: string
  folderId: number | null
  updatedAt: Date
  /** `summaryShort` from the doc's analysis, truncated — only when `includeSummaries`. */
  summary?: string
  /** Analysis tags — only when `includeSummaries`. */
  tags?: string[]
}

export interface OverviewWorkspace {
  id: number
  name: string
  emoji: string | null
  role: WorkspaceRole
  shared: boolean
  folders: OverviewFolder[]
  documents: OverviewDocument[]
  /** Total active docs in the workspace — may exceed `documents.length` when truncated. */
  documentCount: number
  /** True when `documents` was capped at `maxDocsPerWorkspace` (most recently updated kept). */
  truncated: boolean
}

export interface UserOverview {
  workspaces: OverviewWorkspace[]
  totals: { workspaces: number, documents: number }
}

export interface OverviewOptions {
  /** Restrict to one workspace; omitted = all accessible workspaces. */
  workspaceId?: number
  /** Attach `summary` + `tags` from doc analyses (more tokens, more signal). */
  includeSummaries?: boolean
  /** Per-workspace document cap, most recently updated first. */
  maxDocsPerWorkspace?: number
}

const OVERVIEW_MAX_DOCS_DEFAULT = 200
const OVERVIEW_SUMMARY_MAX = 200

/**
 * One-shot map of the user's content: workspaces → folder tree → document
 * titles (+ optional analysis summaries/tags). Built for MCP clients so
 * "what do I have?" costs ONE tool round-trip instead of
 * list_workspaces → get_workspace → list_documents × N.
 */
export async function getUserOverview(
  userId: number,
  options: OverviewOptions = {},
  dek: Buffer | null = null,
): Promise<UserOverview> {
  const scoped = await scopeWorkspaces(userId, options.workspaceId, dek)
  const maxDocs = options.maxDocsPerWorkspace ?? OVERVIEW_MAX_DOCS_DEFAULT

  const db = useDb()
  const keyCache: WorkspaceKeyCache = {}
  const out: OverviewWorkspace[] = []
  let totalDocs = 0

  for (const ws of scoped) {
    const key = await resolveContentKey(ws, userId, dek, keyCache)

    const folderRows = await db
      .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
      .from(folders)
      .where(and(eq(folders.workspaceId, ws.id), activeFoldersWhere()))
      .orderBy(asc(folders.position), asc(folders.id))

    const docRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        folderId: documents.folderId,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.workspaceId, ws.id), activeDocsWhere()))
      .orderBy(desc(documents.updatedAt), desc(documents.id))

    const truncated = docRows.length > maxDocs
    const kept = docRows.slice(0, maxDocs)
    const docs: OverviewDocument[] = kept.map(d => ({
      id: d.id,
      title: decryptDocument({ title: d.title }, key).title ?? 'Untitled',
      folderId: d.folderId,
      updatedAt: d.updatedAt,
    }))

    if (options.includeSummaries && docs.length > 0) {
      const analyses = await db
        .select({ docId: docAnalyses.docId, summaryShort: docAnalyses.summaryShort, tags: docAnalyses.tags })
        .from(docAnalyses)
        .where(inArray(docAnalyses.docId, docs.map(d => d.id)))
      const byDoc = new Map(analyses.map(a => [a.docId, a] as const))
      for (const doc of docs) {
        const a = byDoc.get(doc.id)
        if (!a) continue
        const plain = decryptAnalysis({ summaryShort: a.summaryShort, tags: a.tags ?? [] }, key)
        const summary = (plain.summaryShort ?? '').trim()
        if (summary.length > 0) doc.summary = clampString(summary, OVERVIEW_SUMMARY_MAX)
        if ((plain.tags ?? []).length > 0) doc.tags = plain.tags
      }
    }

    totalDocs += docRows.length
    out.push({
      id: ws.id,
      name: ws.name,
      emoji: ws.emoji,
      role: ws.role,
      shared: ws.shared,
      folders: folderRows.map(f => ({
        id: f.id,
        name: decryptFolder({ name: f.name }, key).name ?? '',
        parentId: f.parentId,
      })),
      documents: docs,
      documentCount: docRows.length,
      truncated,
    })
  }

  return {
    workspaces: out,
    totals: { workspaces: out.length, documents: totalDocs },
  }
}

export interface DocumentMatch {
  docId: number
  title: string
  /** Title-match score in [0, 1] — see `scoreTitleMatch` tiers. */
  score: number
  workspaceId: number
  workspaceName: string
  folderId: number | null
  updatedAt: Date
}

export interface FindDocumentsInput {
  /** Title (or fragment) to look for — accent/case-insensitive. */
  query: string
  /** Exact workspace scope; wins over `workspaceName` when both are set. */
  workspaceId?: number
  /** Fuzzy workspace scope by name (e.g. user said "dans l'espace Travail"). */
  workspaceName?: string
  limit?: number
}

export interface FindDocumentsResult {
  matches: DocumentMatch[]
  /**
   * Set when `workspaceName` matched no workspace — carries the available
   * names so an MCP client can self-correct without an extra
   * list_workspaces round-trip.
   */
  workspaceNameMiss?: { requested: string, available: string[] }
}

const FIND_DOCUMENTS_LIMIT_DEFAULT = 5
/** A workspace name has to clear this to count as "the workspace the user meant". */
const WORKSPACE_NAME_MIN_SCORE = 0.5

/**
 * Resolve "the note called X (in workspace Y)" in one call. Titles are
 * encrypted at rest, so this is the canonical fetch + decrypt + JS-score
 * scan (same pattern as `findOrCreateDailyNote`). Returns ranked matches;
 * content retrieval stays with the caller (`read_document` /
 * `getUserDocument`).
 */
export async function findUserDocuments(
  userId: number,
  input: FindDocumentsInput,
  dek: Buffer | null = null,
): Promise<FindDocumentsResult> {
  const limit = input.limit ?? FIND_DOCUMENTS_LIMIT_DEFAULT

  let scoped: WorkspaceListItem[]
  if (input.workspaceId != null) {
    scoped = await scopeWorkspaces(userId, input.workspaceId, dek)
  }
  else {
    scoped = await scopeWorkspaces(userId, undefined, dek)
    const requestedName = input.workspaceName?.trim()
    if (requestedName) {
      const ranked = scoped
        .map(ws => ({ ws, score: scoreTitleMatch(requestedName, ws.name) }))
        .filter(r => r.score >= WORKSPACE_NAME_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
      if (ranked.length === 0) {
        return {
          matches: [],
          workspaceNameMiss: { requested: requestedName, available: scoped.map(w => w.name) },
        }
      }
      scoped = [ranked[0]!.ws]
    }
  }

  const db = useDb()
  const keyCache: WorkspaceKeyCache = {}
  const matches: DocumentMatch[] = []

  for (const ws of scoped) {
    const key = await resolveContentKey(ws, userId, dek, keyCache)
    const rows = await db
      .select({
        id: documents.id,
        title: documents.title,
        folderId: documents.folderId,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.workspaceId, ws.id), activeDocsWhere()))

    for (const r of rows) {
      const title = decryptDocument({ title: r.title }, key).title ?? ''
      const score = scoreTitleMatch(input.query, title)
      if (score < TITLE_MATCH_MIN_SCORE) continue
      matches.push({
        docId: r.id,
        title,
        score,
        workspaceId: ws.id,
        workspaceName: ws.name,
        folderId: r.folderId,
        updatedAt: r.updatedAt,
      })
    }
  }

  matches.sort((a, b) => (b.score - a.score) || (+b.updatedAt - +a.updatedAt))
  return { matches: matches.slice(0, limit) }
}

/**
 * Append markdown to the end of a document without the caller having to
 * read + merge + rewrite (3 round-trips → 1). Reuses `updateUserDocument`
 * so version snapshots and doc-link reconciliation keep working.
 */
export async function appendToUserDocument(
  userId: number,
  docId: number,
  markdown: string,
  dek: Buffer | null = null,
): Promise<Document> {
  const { document: raw, role } = await assertDocumentMembership(userId, docId)
  assertCanEdit(role)
  if (raw.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: 'Document is in trash' })
  }

  const current = decryptDocument(raw, dek).markdown ?? ''
  const addition = markdown.replace(/^\n+/, '')
  const combined = current.trim().length === 0
    ? addition
    : `${current.replace(/\n+$/, '')}\n\n${addition}`

  return updateUserDocument(userId, docId, { markdown: combined }, dek)
}

export interface TagAggregate {
  name: string
  count: number
  docIds: number[]
}

/**
 * Distinct analysis tags across a workspace's active documents, with
 * per-tag doc ids and counts. Tags are stored encrypted per-element —
 * aggregation happens post-decrypt in JS (SQL `json_each` can't match
 * ciphertext). Shared by `GET /api/workspaces/:id/tags` and the MCP
 * `list_tags` tool.
 */
export async function listUserWorkspaceTags(
  userId: number,
  workspaceId: number,
  dek: Buffer | null = null,
): Promise<TagAggregate[]> {
  const workspace = await assertWorkspaceOwnership(userId, workspaceId)
  const db = useDb()

  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspace.id), activeDocsWhere()))
  if (docs.length === 0) return []

  const analyses = await db
    .select({ docId: docAnalyses.docId, tags: docAnalyses.tags })
    .from(docAnalyses)
    .where(inArray(docAnalyses.docId, docs.map(d => d.id)))

  // Aggregate by lower-case tag name to fold near-duplicates, but display
  // the first capitalisation we saw so the UI stays readable.
  const byKey = new Map<string, { display: string, count: number, docIds: Set<number> }>()
  for (const row of analyses) {
    const tags = decryptAnalysis({ tags: row.tags ?? [] }, dek).tags ?? []
    if (!Array.isArray(tags) || tags.length === 0) continue
    // Within one document, a tag should only count once even if duplicated
    // in the analysis output.
    const seenInDoc = new Set<string>()
    for (const rawTag of tags) {
      if (typeof rawTag !== 'string') continue
      const trimmed = rawTag.trim()
      if (trimmed.length === 0) continue
      const tagKey = trimmed.toLowerCase()
      if (seenInDoc.has(tagKey)) continue
      seenInDoc.add(tagKey)

      const existing = byKey.get(tagKey)
      if (existing) {
        existing.count += 1
        existing.docIds.add(row.docId)
      }
      else {
        byKey.set(tagKey, { display: trimmed, count: 1, docIds: new Set([row.docId]) })
      }
    }
  }

  return Array.from(byKey.values())
    .map(v => ({ name: v.display, count: v.count, docIds: Array.from(v.docIds).sort((a, b) => a - b) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.name.localeCompare(b.name)
    })
}

export interface DocLinkRef {
  docId: number
  title: string
}

export interface DocumentLinks {
  /** Active documents this document links TO (wiki-style links in its body). */
  outgoing: DocLinkRef[]
  /** Active documents that link TO this document. */
  backlinks: DocLinkRef[]
}

/**
 * Wiki-link neighbourhood of a document (both directions, trashed docs
 * excluded). Cheap enough to ride along on every MCP `read_document`.
 */
export async function getUserDocumentLinks(
  userId: number,
  docId: number,
  dek: Buffer | null = null,
): Promise<DocumentLinks> {
  await assertDocumentOwnership(userId, docId)
  const db = useDb()

  const [outgoingRows, incomingRows] = await Promise.all([
    db
      .select({ docId: documents.id, title: documents.title })
      .from(docLinks)
      .innerJoin(documents, eq(documents.id, docLinks.targetDocId))
      .where(and(eq(docLinks.sourceDocId, docId), activeDocsWhere())),
    db
      .select({ docId: documents.id, title: documents.title })
      .from(docLinks)
      .innerJoin(documents, eq(documents.id, docLinks.sourceDocId))
      .where(and(eq(docLinks.targetDocId, docId), activeDocsWhere())),
  ])

  const toRefs = (rows: { docId: number, title: string }[]): DocLinkRef[] => {
    const seen = new Set<number>()
    const refs: DocLinkRef[] = []
    for (const r of rows) {
      if (seen.has(r.docId)) continue
      seen.add(r.docId)
      refs.push({ docId: r.docId, title: decryptField(r.title, dek) })
    }
    refs.sort((a, b) => a.title.localeCompare(b.title))
    return refs
  }

  return { outgoing: toRefs(outgoingRows), backlinks: toRefs(incomingRows) }
}

/* ========================================================================== */
/*  Analyze                                                                    */
/* ========================================================================== */

const ANALYSIS_SYSTEM_PROMPT = `You are NoteForge Analyst, a careful note-summariser.

Always reply with ONE valid JSON object and nothing else (no markdown fences,
no commentary). The JSON MUST match this schema exactly:

{
  "summaryShort": string,         // <= 280 chars, single sentence ideally
  "summaryLong":  string,         // 3 to 6 sentences
  "useCases":     string[],       // 3 to 5 concrete use-cases / applications
  "tags":         string[],       // 5 to 10 lowercase tags, prefer single words,
                                  // multi-word tags must be kebab-case
  "questions":    string[],       // 3 to 5 thought-provoking follow-up questions
  "actionItems":  { "text": string, "done": boolean }[],
                                  // ONLY include items truly present in the
                                  // note (TODOs, action verbs, deadlines).
                                  // Empty array if there are none. Set
                                  // "done": true only for items explicitly
                                  // marked done (e.g. checked checkboxes).
  "language":     string          // BCP-47 code of the note's main language,
                                  // e.g. "en", "fr", "es", "de"
}

Rules:
- Detect the document's language from its content and write every string
  field (summaries, use-cases, tags, questions, actionItems.text) in THAT
  language. Only "language" itself is the BCP-47 code.
- Do NOT invent action items that aren't supported by the text.
- Tags must be lowercase. Multi-word tags use kebab-case (e.g.
  "machine-learning"). Avoid hashtag prefixes.
- Output strictly valid JSON. Do not wrap in \`\`\`json.

Example shape (illustrative values, do not echo):
{
  "summaryShort": "Notes from the kickoff meeting outlining v1 scope.",
  "summaryLong": "The team agreed on a minimal v1 focused on...",
  "useCases": ["Onboarding new engineers", "Quarterly planning input"],
  "tags": ["meeting", "kickoff", "v1", "scope", "engineering"],
  "questions": ["What's the blast-radius of slipping the date?"],
  "actionItems": [{ "text": "Ship login flow by Friday", "done": false }],
  "language": "en"
}`

const ActionItem = z.object({
  text: z.string().trim().min(1).max(500),
  done: z.boolean(),
})

const AnalysisSchema = z.object({
  summaryShort: z.string().trim().max(400).default(''),
  summaryLong: z.string().trim().default(''),
  useCases: z.array(z.string().trim().min(1)).max(15).default([]),
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
  questions: z.array(z.string().trim().min(1)).max(15).default([]),
  actionItems: z.array(ActionItem).max(50).default([]),
  language: z.string().trim().min(2).max(16).nullable().default(null),
})

type Analysis = z.infer<typeof AnalysisSchema>

function clampString(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`
}

function normaliseAnalysis(input: Analysis): Analysis {
  return {
    summaryShort: clampString(input.summaryShort, 280),
    summaryLong: input.summaryLong,
    useCases: input.useCases.slice(0, 5),
    tags: Array.from(
      new Set(
        input.tags
          .map(t => t.toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-'))
          .filter(t => t.length > 0),
      ),
    ).slice(0, 10),
    questions: input.questions.slice(0, 5),
    actionItems: input.actionItems.slice(0, 20),
    language: input.language?.toLowerCase().slice(0, 16) ?? null,
  }
}

function extractMistralDetail(err: unknown): string | null {
  const e = err as { data?: { detail?: string }, statusMessage?: string, message?: string }
  return e?.data?.detail ?? e?.statusMessage ?? e?.message ?? null
}

async function embedDocSummary(
  docId: number,
  title: string,
  analysis: Analysis,
  userId?: number,
): Promise<void> {
  const parts = [
    title.trim(),
    analysis.summaryShort.trim(),
    analysis.summaryLong.trim(),
    analysis.tags.join(', '),
  ].filter(p => p.length > 0)
  const text = parts.join('\n\n').trim()
  if (text.length === 0) return

  const [vec] = await mistralEmbed([text], { userId, operation: 'embed_summary' })
  if (!vec || vec.length === 0) return

  // The summary embedding vector itself is intentionally NOT encrypted —
  // same trade-off as `doc_chunks.embedding_blob`. See CLAUDE.md.
  await useDb()
    .update(docAnalyses)
    .set({ summaryEmbedding: floatsToBuffer(vec) })
    .where(eq(docAnalyses.docId, docId))
}

/**
 * Run a full analysis on a document: Mistral JSON-mode call → upsert
 * `doc_analyses` → kick off chunk re-embedding + summary embedding in the
 * background. Same flow as `ai/analyze/[docId].post.ts`.
 *
 * Returns the persisted analysis row.
 */
export async function analyzeUserDocument(
  userId: number,
  docId: number,
  dek: Buffer | null = null,
): Promise<DocAnalysis> {
  const { document: rawDoc, role } = await assertDocumentMembership(userId, docId)
  assertCanEdit(role)
  const doc = decryptDocument(rawDoc, dek)
  if (doc.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: 'Document is in trash' })
  }
  const md = (doc.markdown ?? '').trim()
  if (md.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Document is empty' })
  }

  const userPrompt = `Title: ${doc.title}\n\n---\n\n${md}`
  const { content } = await mistralChat({
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    jsonMode: true,
    temperature: 0.2,
    userId,
    operation: 'analyze',
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: `Invalid JSON from Mistral: ${(err as Error).message}` },
    })
  }

  const checked = AnalysisSchema.safeParse(parsed)
  if (!checked.success) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: `Schema mismatch: ${checked.error.message}` },
    })
  }
  const analysis = normaliseAnalysis(checked.data)

  const db = useDb()
  const now = new Date()

  const [previous] = await db
    .select({ actionItems: docAnalyses.actionItems })
    .from(docAnalyses)
    .where(eq(docAnalyses.docId, docId))
    .limit(1)

  const previousDone = new Map<string, boolean>()
  if (previous) {
    // `previous.actionItems` is JSON-mode but with encrypted strings inside
    // (post-encryption); decrypt before keying.
    const previousDecrypted = decryptAnalysis({ actionItems: previous.actionItems }, dek).actionItems ?? []
    for (const it of previousDecrypted) {
      if (it.done) previousDone.set(it.text.trim().toLowerCase(), true)
    }
  }
  const mergedActionItems = analysis.actionItems.map(it => ({
    text: it.text,
    done: previousDone.get(it.text.trim().toLowerCase()) ?? it.done,
  }))

  const markdownLength = (doc.markdown ?? '').length

  // Encrypt every analysis text field (and per-string elements inside the
  // JSON-mode arrays) before write.
  const encrypted = encryptAnalysis({
    summaryShort: analysis.summaryShort,
    summaryLong: analysis.summaryLong,
    useCases: analysis.useCases,
    tags: analysis.tags,
    questions: analysis.questions,
    actionItems: mergedActionItems,
  }, dek)

  const [saved] = await db
    .insert(docAnalyses)
    .values({
      docId,
      summaryShort: encrypted.summaryShort!,
      summaryLong: encrypted.summaryLong!,
      useCases: encrypted.useCases!,
      tags: encrypted.tags!,
      questions: encrypted.questions!,
      actionItems: encrypted.actionItems!,
      language: analysis.language,
      generatedAt: now,
      markdownLengthAtAnalysis: markdownLength,
    })
    .onConflictDoUpdate({
      target: docAnalyses.docId,
      set: {
        summaryShort: encrypted.summaryShort!,
        summaryLong: encrypted.summaryLong!,
        useCases: encrypted.useCases!,
        tags: encrypted.tags!,
        questions: encrypted.questions!,
        actionItems: encrypted.actionItems!,
        language: analysis.language,
        generatedAt: now,
        markdownLengthAtAnalysis: markdownLength,
      },
    })
    .returning()

  if (!saved) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to persist analysis' })
  }

  // `embedDocument` writes encrypted chunks; pass DEK + the plaintext
  // markdown so chunking + FTS5 mirror operate on cleartext.
  void Promise.all([
    embedDocument(docId, doc.markdown, dek, userId),
    embedDocSummary(docId, doc.title, analysis, userId),
  ])
    .then(async () => {
      await db
        .update(docAnalyses)
        .set({ embedError: null, embedFailedAt: null })
        .where(eq(docAnalyses.docId, docId))
    })
    .catch(async (err: unknown) => {
      const detail = extractMistralDetail(err) ?? (err as Error)?.message ?? 'unknown error'
      console.error('[notes/analyze] embed step failed', err)
      try {
        await db
          .update(docAnalyses)
          .set({ embedError: detail.slice(0, 1000), embedFailedAt: new Date() })
          .where(eq(docAnalyses.docId, docId))
      }
      catch (writeErr) {
        console.error('[notes/analyze] failed to record embed error', writeErr)
      }
    })

  return decryptAnalysis(saved, dek)
}

/* ========================================================================== */
/*  Daily notes (journal)                                                      */
/* ========================================================================== */

const DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * True when a document title matches the journal-note convention
 * (`YYYY-MM-DD`). The sidebar tree uses this to hide journal notes from
 * the main document list — they're surfaced through the calendar widget
 * instead.
 */
export function isDailyNoteTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && DAILY_DATE_RE.test(title)
}

function buildDailyTemplate(date: string): string {
  // The H1 mirrors the title so the markdown stays readable when opened
  // outside the editor (export / git). Sections cover the typical
  // bullet-journal triad — keep it lean, the user can customise via slash.
  return `# ${date}\n\n## Tâches\n- [ ] \n\n## Notes\n\n\n## Liens\n`
}

/**
 * Find or create the journal note for `date` (`YYYY-MM-DD`). The note's
 * title equals the date string, sat at the workspace root. Subsequent
 * calls return the same row.
 */
export async function findOrCreateDailyNote(
  userId: number,
  workspaceId: number,
  date: string,
  dek: Buffer | null = null,
): Promise<{ document: Document, created: boolean }> {
  if (!DAILY_DATE_RE.test(date)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_date_format' })
  }
  const workspace = await assertWorkspaceOwnership(userId, workspaceId)
  const db = useDb()

  // Encrypted titles can't be matched by SQL equality (every encryption
  // uses a fresh IV → different ciphertext for the same plaintext). Fetch
  // the workspace's active docs and decrypt each title to find the daily.
  // Workspace-scoped scan, fine in practice (a single user / single
  // workspace has at most a few thousand docs).
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, workspace.id), activeDocsWhere()))

  for (const r of rows) {
    const plainTitle = decryptDocument({ title: r.title }, dek).title
    if (plainTitle === date) {
      return { document: decryptDocument(r, dek), created: false }
    }
  }

  const document = await createUserDocument(userId, {
    workspaceId: workspace.id,
    folderId: null,
    title: date,
    markdown: buildDailyTemplate(date),
    contentJson: '{}',
  }, dek)
  return { document, created: true }
}

/**
 * List the dates (YYYY-MM-DD) of journal notes that exist in the given
 * year-month — used by the sidebar calendar to render dots on days that
 * already have a note.
 */
export async function listDailyNotesForMonth(
  userId: number,
  workspaceId: number,
  yearMonth: string,
  dek: Buffer | null = null,
): Promise<string[]> {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_month_format' })
  }
  const workspace = await assertWorkspaceOwnership(userId, workspaceId)
  const db = useDb()

  // Once titles are encrypted at rest, SQL `LIKE` can't filter by prefix.
  // Fetch every active doc and filter post-decrypt. Same cost shape as
  // `findOrCreateDailyNote`. Pre-encryption rows (plaintext) flow through
  // `decryptDocument` unchanged.
  const rows = await db
    .select({ title: documents.title })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspace.id), activeDocsWhere()))

  const out: string[] = []
  const prefix = `${yearMonth}-`
  for (const r of rows) {
    const plain = decryptDocument({ title: r.title }, dek).title ?? ''
    if (plain.startsWith(prefix) && DAILY_DATE_RE.test(plain)) out.push(plain)
  }
  return out
}
