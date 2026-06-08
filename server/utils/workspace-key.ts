/**
 * Workspace-scoped key resolution for the at-rest encryption layer.
 *
 * Bridges the per-user DEK model (solo workspaces) and the per-workspace
 * WEK model (shared workspaces — see `workspaces.encryptionMode`).
 *
 *   - `'dek'` workspace: content is encrypted under the owner's DEK. The
 *     resolver just returns the DEK from the session.
 *   - `'wek'` workspace: content is encrypted under the workspace's WEK.
 *     The resolver looks up the caller's `workspace_shares` row, unwraps
 *     their X25519 private key with the DEK, then opens the sealed WEK.
 *
 * Both paths cache the resolved key on `event.context` for the lifetime
 * of the request so a chain of access checks + decrypts doesn't repeat
 * the unwrap. The membership check (`assertWorkspaceMembership`) returns
 * the role too — viewers are gated out of mutating endpoints by the
 * callers.
 *
 * MCP requests: pass the bearer-unwrapped DEK and `userId` explicitly via
 * `getWorkspaceKeyForUser` — there is no H3 session.
 */
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { and, eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import {
  users,
  workspaces,
  workspaceShares,
  type Workspace,
} from '~/server/database/schema'
import { openSealed, unwrap } from './crypto'
import { getDek } from './dek'
import { requireUser } from './require-user'

/* -------------------------------------------------------------------------- */
/*  Per-request caches                                                         */
/* -------------------------------------------------------------------------- */

const PRIVATE_KEY_CTX_KEY = '__noteforgePrivKey__' as const
const WEK_CACHE_CTX_KEY = '__noteforgeWekCache__' as const

interface KeyContext {
  [PRIVATE_KEY_CTX_KEY]?: Buffer | null
  [WEK_CACHE_CTX_KEY]?: Map<number, Buffer>
}

/**
 * Opaque per-request cache for key resolution. H3 callers pass
 * `event.context`; sessionless callers (MCP) allocate a plain `{}` once
 * per request and thread it through every resolution so the private-key
 * unwrap and each workspace's WEK open are paid at most once.
 */
export type WorkspaceKeyCache = KeyContext

async function loadWorkspace(workspaceId: number): Promise<Workspace> {
  const db = useDb()
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!ws) {
    throw createError({ statusCode: 404, statusMessage: 'Workspace not found' })
  }
  return ws
}

/* -------------------------------------------------------------------------- */
/*  Key resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the symmetric key used to encrypt/decrypt content for this
 * workspace. Cached per-request on `event.context` so multiple operations
 * touching the same workspace pay the unwrap cost once.
 *
 * Returns `null` when the caller has no DEK on the session (legacy /
 * pre-encryption flow). Same convention as `getDek` — downstream
 * helpers (`encrypted-entities.ts`) treat `null` as a pass-through.
 */
export async function getWorkspaceKey(event: H3Event, workspaceId: number): Promise<Buffer | null> {
  const workspace = await loadWorkspace(workspaceId)
  return resolveKeyForEvent(event, workspace)
}

/**
 * Same as `getWorkspaceKey` but takes a pre-loaded workspace row, useful
 * when a caller already has it (avoids a second SELECT). Also reusable
 * outside H3 (MCP, scripts) via the explicit `userId + dek` overload below.
 */
export async function resolveKeyForEvent(event: H3Event, workspace: Workspace): Promise<Buffer | null> {
  const dek = await getDek(event)
  if (!dek) return null
  const user = await requireUser(event)
  return resolveKeyForUser({
    workspace,
    userId: user.id,
    dek,
    cache: ((event.context as unknown) as KeyContext),
  })
}

interface ResolveArgs {
  workspace: Workspace
  userId: number
  dek: Buffer
  /** Optional per-request cache (event.context for H3 callers). */
  cache?: KeyContext
}

/**
 * Resolve the workspace key from explicit credentials. Used by MCP tools
 * (no H3 session) — they pass the userId + DEK they unwrapped from the
 * bearer.
 *
 * Throws 403 if the user has no membership row for a shared workspace,
 * or 404 if a shared workspace's share row vanished mid-request.
 */
export async function getWorkspaceKeyForUser(args: ResolveArgs): Promise<Buffer> {
  return resolveKeyForUser(args)
}

/**
 * Same as `getWorkspaceKeyForUser` but loads the workspace row itself.
 * Convenience for callers that only hold a workspace id (MCP key
 * resolvers). Returns `null` when the caller has no DEK (legacy /
 * pre-encryption tokens) — pass-through convention, same as `getDek`.
 */
export async function getWorkspaceKeyForUserById(
  userId: number,
  workspaceId: number,
  dek: Buffer | null,
  cache?: WorkspaceKeyCache,
): Promise<Buffer | null> {
  if (!dek) return null
  const workspace = await loadWorkspace(workspaceId)
  return resolveKeyForUser({ workspace, userId, dek, cache })
}

async function resolveKeyForUser({ workspace, userId, dek, cache }: ResolveArgs): Promise<Buffer> {
  if (workspace.encryptionMode === 'dek') {
    // Solo workspace — content is encrypted under the owner's DEK. The
    // caller is the owner (membership check has run upstream), so the
    // DEK on the session is the right key.
    return dek
  }

  // Shared workspace — look up the sealed WEK for this user.
  if (cache?.[WEK_CACHE_CTX_KEY]) {
    const hit = cache[WEK_CACHE_CTX_KEY].get(workspace.id)
    if (hit) return hit
  }

  const db = useDb()
  const [share] = await db
    .select({ wrappedWek: workspaceShares.wrappedWek })
    .from(workspaceShares)
    .where(and(eq(workspaceShares.workspaceId, workspace.id), eq(workspaceShares.userId, userId)))
    .limit(1)
  if (!share) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  // The caller's keypair: public key clear on the user row, private key
  // wrapped under their DEK. Unwrap once per request via the context cache.
  let privateKey: Buffer | null = cache?.[PRIVATE_KEY_CTX_KEY] ?? null
  let publicKey: Buffer | null = null

  if (!privateKey) {
    const [u] = await db
      .select({ publicKey: users.publicKey, wrappedPrivateKey: users.wrappedPrivateKey })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!u?.publicKey || !u.wrappedPrivateKey) {
      throw createError({
        statusCode: 409,
        statusMessage: 'missing_keypair',
        data: { detail: 'User has no keypair yet — log out and back in to provision one.' },
      })
    }
    privateKey = unwrap(u.wrappedPrivateKey, dek)
    publicKey = u.publicKey
    if (cache) cache[PRIVATE_KEY_CTX_KEY] = privateKey
  }
  else {
    // Cache hit — still need the public key for the sealed-box open. Fetch
    // it cheaply (small column on the users row).
    const [u] = await db
      .select({ publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!u?.publicKey) {
      throw createError({ statusCode: 409, statusMessage: 'missing_keypair' })
    }
    publicKey = u.publicKey
  }

  const wek = openSealed(share.wrappedWek, privateKey, publicKey)

  if (cache) {
    if (!cache[WEK_CACHE_CTX_KEY]) cache[WEK_CACHE_CTX_KEY] = new Map()
    cache[WEK_CACHE_CTX_KEY].set(workspace.id, wek)
  }

  return wek
}

/**
 * Convenience for endpoints that already resolved the membership and just
 * need the key. Same caching semantics as `getWorkspaceKey`.
 */
export async function getWorkspaceKeyFromWorkspace(
  event: H3Event,
  workspace: Workspace,
): Promise<Buffer | null> {
  return resolveKeyForEvent(event, workspace)
}
