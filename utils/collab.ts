/**
 * Live collaboration plumbing shared by the Nitro room manager
 * (server/utils/collab/rooms.ts) and the browser (composables/useCollab.ts).
 *
 * Wire format: the standard y-websocket framing — a varuint message type then
 * the payload. 0 = sync, 1 = awareness, 3 = query awareness are the y-protocols
 * types; 100+ are NoteForge control frames with an empty payload.
 *
 * Deliberately dependency-free (no yjs, no h3, no db) so vitest can import it —
 * same rationale as `utils/excalidraw-scene.ts`.
 */

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3
/** Server → client: the room has no state yet; load the stored markdown into
 *  the empty fragment. Authoritative for an editor, local-only for a viewer
 *  (the server drops a viewer's updates). */
export const MSG_SEED = 100
/** Server → client: the room was invalidated (markdown written outside the
 *  live session — MCP, version restore, move…). Drop the Y.Doc and reload. */
export const MSG_RESET = 101

/** y-protocols sync sub-types. Only step 1 (a state-vector request) carries no
 *  content, so it is the only one a viewer may send. */
export const SYNC_STEP1 = 0
export const SYNC_STEP2 = 1
export const SYNC_UPDATE = 2

/** Close codes. y-websocket stops reconnecting on 4400-4499. */
export const CLOSE_RESET = 4409
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_FORBIDDEN = 4403

/** Name of the Tiptap Collaboration fragment and of the metadata map. */
export const COLLAB_FRAGMENT = 'default'
export const COLLAB_META = 'meta'

/** Can this sync sub-type mutate the document? */
export function isWriteSyncType(syncType: number): boolean {
  return syncType === SYNC_STEP2 || syncType === SYNC_UPDATE
}

/** What every client publishes in its awareness `user` field. */
export interface CollabUser {
  id: number
  name: string
  color: string
  canEdit: boolean
}

const PALETTE = [
  '#e8590c', '#1c7ed6', '#2f9e44', '#c2255c', '#7048e8',
  '#0c8599', '#e67700', '#5c940d', '#d6336c', '#3b5bdb',
] as const

/** Stable per-user colour, so a collaborator keeps theirs across sessions. */
export function colorForUser(userId: number): string {
  // Knuth multiplicative hash — consecutive ids land on distant colours.
  const h = Math.imul(userId, 2654435761) >>> 0
  return PALETTE[h % PALETTE.length] ?? PALETTE[0]
}

/** Label shown on a cursor / avatar: display name, else the email local part. */
export function labelForUser(user: { email: string, displayName?: string | null }): string {
  const name = user.displayName?.trim()
  if (name) return name
  return user.email.split('@')[0] || user.email
}

export function initialsFor(label: string): string {
  const parts = label.trim().split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? '?'
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : ''
  return (a + b).toUpperCase()
}

/**
 * The leader is the one client that persists markdown through the regular
 * PATCH pipeline (snapshots, doc-links). Every client computes it from the
 * same awareness states, so they agree without a round-trip: the editor with
 * the lowest Yjs clientID.
 */
export function pickLeaderClientId(
  states: Iterable<[number, { user?: Partial<CollabUser> } | undefined]>,
): number | null {
  let leader: number | null = null
  for (const [clientId, state] of states) {
    if (!state?.user?.canEdit) continue
    if (leader === null || clientId < leader) leader = clientId
  }
  return leader
}
