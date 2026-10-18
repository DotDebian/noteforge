import { computed, ref, shallowRef, type Ref } from 'vue'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import {
  COLLAB_FRAGMENT,
  COLLAB_META,
  MSG_RESET,
  MSG_SEED,
  pickLeaderClientId,
  type CollabUser,
} from '~/utils/collab'

export type CollabStatus = 'connecting' | 'live' | 'offline' | 'denied'

export interface CollabPeer extends CollabUser {
  clientId: number
  isSelf: boolean
}

export interface UseCollabReturn {
  ydoc: Y.Doc
  provider: WebsocketProvider
  fragment: Y.XmlFragment
  meta: Y.Map<string>
  status: Ref<CollabStatus>
  /** First sync with the server done — the fragment reflects the room. */
  synced: Ref<boolean>
  /** This tab persists markdown for the room (see `pickLeaderClientId`). */
  isLeader: Ref<boolean>
  peers: Ref<CollabPeer[]>
  /** Set when the server asked this client to seed the empty room. */
  seedRequested: Ref<boolean>
  destroy: () => void
}

/**
 * One live-collaboration session for a document: a Y.Doc wired to
 * `/_collab/:docId` through y-websocket's client. The server side is
 * server/utils/collab/rooms.ts; the frame types live in utils/collab.ts.
 *
 * `onReset` fires when the server invalidated the room (markdown written
 * elsewhere): the provider is already torn down, the caller refetches and
 * remounts.
 */
export function useCollab(
  docId: number,
  user: CollabUser,
  onReset: () => void,
): UseCollabReturn {
  const ydoc = new Y.Doc()
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new WebsocketProvider(`${proto}//${window.location.host}/_collab`, String(docId), ydoc, {
    // The server is the authority (it filters viewer writes); a same-browser
    // BroadcastChannel would bypass it.
    disableBc: true,
  })

  const status = ref<CollabStatus>('connecting')
  const synced = ref(false)
  const seedRequested = ref(false)
  const awarenessStates = shallowRef<Map<number, { user?: CollabUser }>>(new Map())

  provider.on('status', ({ status: s }: { status: string }) => {
    if (status.value === 'denied') return
    if (s === 'connected') status.value = 'live'
    else if (s === 'disconnected') status.value = synced.value ? 'offline' : 'connecting'
  })
  provider.on('sync', (isSynced: boolean) => {
    if (isSynced) synced.value = true
  })
  provider.on('connection-close', (event: CloseEvent | null) => {
    // 44xx = permanent refusal (y-websocket stops retrying on its own).
    if (event && event.code >= 4400 && event.code < 4500 && event.code !== 4409) {
      status.value = 'denied'
    }
  })

  // NoteForge control frames (payload-less; see utils/collab.ts).
  provider.messageHandlers[MSG_SEED] = () => {
    seedRequested.value = true
  }
  provider.messageHandlers[MSG_RESET] = () => {
    // Out of the socket's onmessage before tearing the provider down.
    queueMicrotask(() => {
      destroy()
      onReset()
    })
  }

  provider.awareness.setLocalStateField('user', user)
  const refreshAwareness = () => {
    awarenessStates.value = new Map(provider.awareness.getStates() as Map<number, { user?: CollabUser }>)
  }
  provider.awareness.on('change', refreshAwareness)
  refreshAwareness()

  const isLeader = computed(() => pickLeaderClientId(awarenessStates.value) === ydoc.clientID)

  const peers = computed<CollabPeer[]>(() => {
    const out: CollabPeer[] = []
    const seenUsers = new Set<number>()
    // Self first, then one entry per user (several tabs = one avatar).
    const ordered = [...awarenessStates.value].sort(([a], [b]) =>
      a === ydoc.clientID ? -1 : b === ydoc.clientID ? 1 : a - b)
    for (const [clientId, state] of ordered) {
      const u = state?.user
      if (!u || seenUsers.has(u.id)) continue
      seenUsers.add(u.id)
      out.push({ ...u, clientId, isSelf: clientId === ydoc.clientID })
    }
    return out
  })

  let destroyed = false
  function destroy() {
    if (destroyed) return
    destroyed = true
    provider.awareness.off('change', refreshAwareness)
    provider.destroy()
    ydoc.destroy()
  }

  return {
    ydoc,
    provider,
    fragment: ydoc.getXmlFragment(COLLAB_FRAGMENT),
    meta: ydoc.getMap<string>(COLLAB_META),
    status,
    synced,
    isLeader,
    peers,
    seedRequested,
    destroy,
  }
}
