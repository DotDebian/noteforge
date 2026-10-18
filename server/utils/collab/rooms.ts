/**
 * Live-collaboration rooms — one in-memory Y.Doc per open document.
 *
 * Prod is a single Nitro process, so a module-level Map is the whole
 * coordination layer (no Redis). A room lives while at least one socket is
 * attached; its state is persisted, encrypted under the workspace key, to
 * `documents.ydoc_state` (throttled, plus a flush when the last peer leaves).
 *
 * The Y.Doc is the live source of truth, but `documents.markdown` stays the
 * source of truth for everything else (search, RAG, MCP, exports): the leader
 * client keeps PATCHing it through the normal pipeline. When markdown is
 * written by anyone else, `invalidateCollab` throws the Y state away so the
 * next room reseeds from the fresh markdown.
 *
 * Viewers are read-only here, not just in the UI: their sync step 2 / update
 * frames are dropped. Their awareness (cursor, avatar) is relayed.
 */
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { and, eq, isNotNull } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { documents } from '~/server/database/schema'
import { decryptField, encryptField } from '~/server/utils/crypto'
import {
  CLOSE_RESET,
  COLLAB_FRAGMENT,
  COLLAB_META,
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_RESET,
  MSG_SEED,
  MSG_SYNC,
  isWriteSyncType,
} from '~/utils/collab'

/** The slice of a crossws Peer we use — keeps this module testable. */
export interface CollabPeer {
  readonly id: string
  send: (data: Uint8Array) => void
  close: (code?: number, reason?: string) => void
}

export interface CollabPeerInfo {
  userId: number
  docId: number
  canEdit: boolean
  key: Buffer
}

interface PeerEntry {
  peer: CollabPeer
  info: CollabPeerInfo
  /** Awareness clientIDs this socket has published — removed on leave. */
  clientIds: Set<number>
}

interface Room {
  docId: number
  key: Buffer
  ydoc: Y.Doc
  awareness: awarenessProtocol.Awareness
  peers: Map<string, PeerEntry>
  seeded: boolean
  /** Editor peer asked to seed the empty room, until the fragment fills. */
  seederPeerId: string | null
  /** Viewers that rendered a local, non-authoritative seed — they need a
   *  reset once an editor seeds for real, or they'd show both copies. */
  localSeeded: Set<string>
  persistTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

const PERSIST_THROTTLE_MS = 2000

const rooms = new Map<number, Room>()
const loading = new Map<number, Promise<Room>>()

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

async function loadRoom(docId: number, key: Buffer): Promise<Room> {
  const db = useDb()
  const [row] = await db
    .select({ ydocState: documents.ydocState, title: documents.title })
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1)

  const ydoc = new Y.Doc({ gc: true })
  if (row?.ydocState) {
    try {
      const b64 = decryptField(row.ydocState, key)
      if (b64) Y.applyUpdate(ydoc, Buffer.from(b64, 'base64'), 'server')
    }
    catch (err) {
      // Wrong key (workspace re-keyed under us) or a corrupt blob: reseed
      // from markdown rather than refuse the room.
      console.error('[collab] unreadable ydoc_state for doc', docId, err)
    }
  }

  const seeded = ydoc.getXmlFragment(COLLAB_FRAGMENT).length > 0
  const meta = ydoc.getMap<string>(COLLAB_META)
  if (!meta.has('title') && row) {
    ydoc.transact(() => meta.set('title', decryptField(row.title, key) || 'Untitled'), 'server')
  }

  const room: Room = {
    docId,
    key,
    ydoc,
    awareness: new awarenessProtocol.Awareness(ydoc),
    peers: new Map(),
    seeded,
    seederPeerId: null,
    localSeeded: new Set(),
    persistTimer: null,
    closed: false,
  }
  // The server holds no cursor of its own.
  room.awareness.setLocalState(null)

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (room.closed) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    broadcast(room, encoding.toUint8Array(enc), typeof origin === 'string' ? origin : null)
    schedulePersist(room)
    if (!room.seeded && ydoc.getXmlFragment(COLLAB_FRAGMENT).length > 0) onSeeded(room)
  })

  room.awareness.on('update', (
    { added, updated, removed }: { added: number[], updated: number[], removed: number[] },
    origin: unknown,
  ) => {
    if (room.closed) return
    if (typeof origin === 'string') {
      const entry = room.peers.get(origin)
      if (entry) {
        for (const id of added) entry.clientIds.add(id)
        for (const id of removed) entry.clientIds.delete(id)
      }
    }
    const changed = [...added, ...updated, ...removed]
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed))
    broadcast(room, encoding.toUint8Array(enc), null)
  })

  return room
}

async function getRoom(docId: number, key: Buffer): Promise<Room> {
  const live = rooms.get(docId)
  if (live) return live
  let p = loading.get(docId)
  if (!p) {
    p = loadRoom(docId, key).then((room) => {
      rooms.set(docId, room)
      return room
    }).finally(() => loading.delete(docId))
    loading.set(docId, p)
  }
  return p
}

function destroyRoom(room: Room): void {
  room.closed = true
  if (room.persistTimer) clearTimeout(room.persistTimer)
  room.persistTimer = null
  room.awareness.destroy()
  room.ydoc.destroy()
  if (rooms.get(room.docId) === room) rooms.delete(room.docId)
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

function schedulePersist(room: Room): void {
  if (room.persistTimer) return
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null
    void persist(room)
  }, PERSIST_THROTTLE_MS)
}

async function persist(room: Room): Promise<void> {
  if (room.closed || !room.seeded) return
  const b64 = Buffer.from(Y.encodeStateAsUpdate(room.ydoc)).toString('base64')
  try {
    // `updated_at` untouched: the leader's markdown PATCH owns that column.
    await useDb()
      .update(documents)
      .set({ ydocState: encryptField(b64, room.key) })
      .where(eq(documents.id, room.docId))
  }
  catch (err) {
    console.error('[collab] persist failed for doc', room.docId, err)
  }
}

/* -------------------------------------------------------------------------- */
/*  Messaging                                                                  */
/* -------------------------------------------------------------------------- */

function send(peer: CollabPeer, data: Uint8Array): void {
  try {
    peer.send(data)
  }
  catch (err) {
    console.error('[collab] send failed', err)
  }
}

function broadcast(room: Room, data: Uint8Array, exceptPeerId: string | null): void {
  for (const [id, entry] of room.peers) {
    if (id !== exceptPeerId) send(entry.peer, data)
  }
}

function control(type: number): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  return encoding.toUint8Array(enc)
}

function onSeeded(room: Room): void {
  room.seeded = true
  room.seederPeerId = null
  for (const id of room.localSeeded) {
    const entry = room.peers.get(id)
    if (entry) {
      send(entry.peer, control(MSG_RESET))
      entry.peer.close(CLOSE_RESET, 'seeded')
    }
  }
  room.localSeeded.clear()
}

/** Hand the seeding job to `entry` if the room still needs one. */
function maybeAskToSeed(room: Room, entry: PeerEntry): void {
  if (room.seeded) return
  if (entry.info.canEdit) {
    if (room.seederPeerId && room.peers.has(room.seederPeerId)) return
    room.seederPeerId = entry.peer.id
    send(entry.peer, control(MSG_SEED))
  }
  else {
    room.localSeeded.add(entry.peer.id)
    send(entry.peer, control(MSG_SEED))
  }
}

export async function joinRoom(peer: CollabPeer, info: CollabPeerInfo): Promise<void> {
  const room = await getRoom(info.docId, info.key)
  const entry: PeerEntry = { peer, info, clientIds: new Set() }
  room.peers.set(peer.id, entry)

  // Server step 1: ask the client for what it has that we don't.
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeSyncStep1(enc, room.ydoc)
  send(peer, encoding.toUint8Array(enc))

  const states = room.awareness.getStates()
  if (states.size > 0) {
    const aw = encoding.createEncoder()
    encoding.writeVarUint(aw, MSG_AWARENESS)
    encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]))
    send(peer, encoding.toUint8Array(aw))
  }

  maybeAskToSeed(room, entry)
}

export function handleMessage(peer: CollabPeer, docId: number, data: Uint8Array): void {
  const room = rooms.get(docId)
  const entry = room?.peers.get(peer.id)
  if (!room || !entry || room.closed) return

  try {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    switch (type) {
      case MSG_SYNC: {
        // Peek the sub-type without consuming it: readSyncMessage re-reads it.
        const syncType = decoding.peekVarUint(decoder)
        if (!entry.info.canEdit && isWriteSyncType(syncType)) return
        const reply = encoding.createEncoder()
        encoding.writeVarUint(reply, MSG_SYNC)
        syncProtocol.readSyncMessage(decoder, reply, room.ydoc, peer.id)
        if (encoding.length(reply) > 1) send(peer, encoding.toUint8Array(reply))
        break
      }
      case MSG_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder)
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, peer.id)
        break
      }
      case MSG_QUERY_AWARENESS: {
        const aw = encoding.createEncoder()
        encoding.writeVarUint(aw, MSG_AWARENESS)
        encoding.writeVarUint8Array(
          aw,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
        )
        send(peer, encoding.toUint8Array(aw))
        break
      }
      default:
        // Control frames only flow server → client; anything else is noise.
        break
    }
  }
  catch (err) {
    console.error('[collab] bad frame from peer', peer.id, err)
  }
}

export async function leaveRoom(peer: CollabPeer, docId: number): Promise<void> {
  const room = rooms.get(docId)
  const entry = room?.peers.get(peer.id)
  if (!room || !entry) return

  room.peers.delete(peer.id)
  room.localSeeded.delete(peer.id)
  if (entry.clientIds.size > 0) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...entry.clientIds], null)
  }

  if (room.peers.size === 0) {
    if (room.persistTimer) clearTimeout(room.persistTimer)
    room.persistTimer = null
    await persist(room)
    // A new peer may have raced in during the await.
    if (room.peers.size === 0) destroyRoom(room)
    return
  }

  if (room.seederPeerId === peer.id) {
    room.seederPeerId = null
    for (const other of room.peers.values()) {
      if (other.info.canEdit) {
        maybeAskToSeed(room, other)
        break
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Hooks for the rest of the server                                           */
/* -------------------------------------------------------------------------- */

/**
 * Markdown was written outside the live session (MCP, version restore, a
 * cross-workspace move, an old client…). Drop the Y state so the next room
 * reseeds from the new markdown, and send connected clients a reset.
 */
export async function invalidateCollab(docId: number): Promise<void> {
  const room = rooms.get(docId)
  if (room) {
    const frame = control(MSG_RESET)
    for (const entry of room.peers.values()) {
      send(entry.peer, frame)
      entry.peer.close(CLOSE_RESET, 'reset')
    }
    room.peers.clear()
    destroyRoom(room)
  }
  await useDb()
    .update(documents)
    .set({ ydocState: null })
    .where(and(eq(documents.id, docId), isNotNull(documents.ydocState)))
}

/** Title changed outside the editor (sidebar rename): push it into the room
 *  so the leader doesn't PATCH the old one back. */
export function syncCollabTitle(docId: number, title: string): void {
  const room = rooms.get(docId)
  if (!room || room.closed) return
  const meta = room.ydoc.getMap<string>(COLLAB_META)
  if (meta.get('title') === title) return
  room.ydoc.transact(() => meta.set('title', title), 'server')
}

/** Is there a live room for this document right now? */
export function hasCollabRoom(docId: number): boolean {
  return rooms.has(docId)
}
