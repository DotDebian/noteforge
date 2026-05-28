import type { H3Event } from 'h3'
import { createError } from 'h3'
import { and, eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import {
  documents,
  folders,
  workspaces,
  workspaceShares,
  type Document,
  type Folder,
  type Workspace,
  type WorkspaceRole,
} from '~/server/database/schema'
import { requireUser } from './require-user'

/* -------------------------------------------------------------------------- */
/*  userId-keyed ownership checks                                              */
/*                                                                             */
/*  Lower-level than the H3-event variants below — they take a numeric user    */
/*  id, no session lookup. Used by:                                            */
/*    - the event-based wrappers (which resolve the user via `requireUser`),   */
/*    - `server/utils/notes.ts` so MCP tools can share the same access logic   */
/*      after the user has been resolved from an MCP bearer token.             */
/*                                                                             */
/*  Lookup-by-id intentionally does NOT filter soft-deleted rows — that's      */
/*  consistent with the REST endpoints (trash / restore needs to read trashed  */
/*  rows). Callers that want to hide trashed rows must check `deletedAt`.      */
/* -------------------------------------------------------------------------- */

/**
 * Look up the caller's effective role on `workspaceId`. Used as the
 * primitive both for membership-based checks (any member) and for
 * ownership checks (`'owner'` only). Returns `null` if the caller is
 * neither owner nor a member.
 *
 * Solo workspaces (`encryptionMode = 'dek'`): only `workspaces.ownerId`
 * grants access; that user is treated as `'owner'`.
 *
 * Shared workspaces (`encryptionMode = 'wek'`): the role comes from
 * `workspace_shares`. The owner has a row there too with `role = 'owner'`
 * so the lookup is uniform.
 */
async function lookupRole(userId: number, workspaceId: number): Promise<{ workspace: Workspace, role: WorkspaceRole } | null> {
  const db = useDb()
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!ws) return null

  if (ws.encryptionMode === 'wek') {
    const [share] = await db
      .select({ role: workspaceShares.role })
      .from(workspaceShares)
      .where(and(eq(workspaceShares.workspaceId, workspaceId), eq(workspaceShares.userId, userId)))
      .limit(1)
    if (!share) return null
    return { workspace: ws, role: share.role }
  }

  // Solo — only the owner has access.
  if (ws.ownerId !== userId) return null
  return { workspace: ws, role: 'owner' }
}

/**
 * Workspace access check — kept under the historical "Ownership" name to
 * minimise call-site churn. Semantically it now means "the caller is a
 * member of this workspace" (which for solo workspaces means owner, for
 * shared workspaces means any role). Mutating endpoints gate viewers
 * separately via `assertCanEdit(role)` once they have the role from
 * `assertWorkspaceMembership`.
 */
export async function assertWorkspaceOwnership(
  userId: number,
  workspaceId: number,
): Promise<Workspace> {
  const lookup = await lookupRole(userId, workspaceId)
  if (!lookup) {
    const db = useDb()
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return lookup.workspace
}

/**
 * Any-member access check — same as `assertWorkspaceOwnership` but also
 * returns the caller's role so the endpoint can gate mutations via
 * `assertCanEdit(role)`. Prefer this in new mutation-bearing endpoints.
 */
export async function assertWorkspaceMembership(
  userId: number,
  workspaceId: number,
): Promise<{ workspace: Workspace, role: WorkspaceRole }> {
  const lookup = await lookupRole(userId, workspaceId)
  if (!lookup) {
    const db = useDb()
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return lookup
}

/**
 * Strict owner-only check. Used for workspace-admin operations (delete
 * workspace, share, revoke). Throws 403 (`'owner_only'`) for editors /
 * viewers.
 */
export async function assertWorkspaceOwner(
  userId: number,
  workspaceId: number,
): Promise<Workspace> {
  const { workspace, role } = await assertWorkspaceMembership(userId, workspaceId)
  if (role !== 'owner') {
    throw createError({ statusCode: 403, statusMessage: 'owner_only' })
  }
  return workspace
}

/** Mutating endpoints call this to refuse `'viewer'` callers cleanly. */
export function assertCanEdit(role: WorkspaceRole): void {
  if (role === 'viewer') {
    throw createError({ statusCode: 403, statusMessage: 'read_only_member' })
  }
}

/**
 * Folder access: any member of the parent workspace is allowed. The
 * function name kept its historical "Ownership" suffix to minimise churn
 * in call sites, but semantically it now means "is a member" — pair with
 * `assertCanEdit(role)` from the membership variants below when the
 * endpoint mutates.
 */
export async function assertFolderOwnership(
  userId: number,
  folderId: number,
): Promise<Folder> {
  const db = useDb()
  const [folder] = await db
    .select()
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)

  if (!folder) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }

  const lookup = await lookupRole(userId, folder.workspaceId)
  if (!lookup) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return folder
}

export async function assertFolderMembership(
  userId: number,
  folderId: number,
): Promise<{ folder: Folder, workspace: Workspace, role: WorkspaceRole }> {
  const db = useDb()
  const [folder] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1)
  if (!folder) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }
  const lookup = await lookupRole(userId, folder.workspaceId)
  if (!lookup) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return { folder, workspace: lookup.workspace, role: lookup.role }
}

export async function assertDocumentOwnership(
  userId: number,
  docId: number,
): Promise<Document> {
  const db = useDb()
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1)

  if (!doc) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }

  const lookup = await lookupRole(userId, doc.workspaceId)
  if (!lookup) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return doc
}

export async function assertDocumentMembership(
  userId: number,
  docId: number,
): Promise<{ document: Document, workspace: Workspace, role: WorkspaceRole }> {
  const db = useDb()
  const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1)
  if (!doc) {
    throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  }
  const lookup = await lookupRole(userId, doc.workspaceId)
  if (!lookup) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return { document: doc, workspace: lookup.workspace, role: lookup.role }
}

/**
 * Ensures the current session user owns the workspace.
 * Returns the workspace row. Throws 401, 404 or 403.
 */
export async function assertWorkspaceAccess(
  event: H3Event,
  workspaceId: number,
): Promise<Workspace> {
  const user = await requireUser(event)
  return assertWorkspaceOwnership(user.id, workspaceId)
}

/**
 * Ensures the current session user owns the workspace that contains the folder.
 */
export async function assertFolderAccess(
  event: H3Event,
  folderId: number,
): Promise<Folder> {
  const user = await requireUser(event)
  return assertFolderOwnership(user.id, folderId)
}

/**
 * Ensures the current session user owns the workspace that contains the document.
 */
export async function assertDocumentAccess(
  event: H3Event,
  docId: number,
): Promise<Document> {
  const user = await requireUser(event)
  return assertDocumentOwnership(user.id, docId)
}

/**
 * Helper used by route handlers: parse an `id` router param as a positive integer.
 */
export function parseIdParam(event: H3Event, name = 'id'): number {
  const raw = getRouterParam(event, name)
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n <= 0) {
    throw createError({ statusCode: 400, statusMessage: `Invalid ${name}` })
  }
  return n
}
