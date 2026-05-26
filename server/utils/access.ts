import type { H3Event } from 'h3'
import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import {
  documents,
  folders,
  workspaces,
  type Document,
  type Folder,
  type Workspace,
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

export async function assertWorkspaceOwnership(
  userId: number,
  workspaceId: number,
): Promise<Workspace> {
  const db = useDb()
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)

  if (!ws) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }
  if (ws.ownerId !== userId) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return ws
}

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

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, folder.workspaceId))
    .limit(1)

  if (!ws || ws.ownerId !== userId) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  return folder
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

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, doc.workspaceId))
    .limit(1)

  if (!ws || ws.ownerId !== userId) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  return doc
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
