/**
 * Live-collaboration WebSocket — `/_collab/:docId`.
 *
 * Auth happens at upgrade time from the session cookie (same DEK-on-session
 * contract as the REST layer). A refused join is NOT rejected at upgrade —
 * the browser would only see a generic failure and y-websocket would retry
 * forever — it is accepted then closed in `open` with a 44xx code, which
 * y-websocket treats as permanent.
 *
 * Only markdown notes of shared (`wek`) workspaces get a room; everything
 * else stays on the single-writer PATCH path.
 */
import { assertDocumentMembership } from '~/server/utils/access'
import { handleMessage, joinRoom, leaveRoom, type CollabPeerInfo } from '~/server/utils/collab/rooms'
import { getWorkspaceKeyForUserById } from '~/server/utils/workspace-key'
import { CLOSE_FORBIDDEN, CLOSE_UNAUTHORIZED } from '~/utils/collab'

const CTX_INFO = 'collab'
const CTX_DENIED = 'collabDenied'
const CTX_JOINED = 'collabJoined'

function docIdFromUrl(url: string): number | null {
  const m = /\/_collab\/(\d+)(?:[/?#]|$)/.exec(new URL(url, 'http://x').pathname + '/')
  const id = m ? Number(m[1]) : NaN
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function authorize(request: Parameters<typeof getUserSession>[0] & { url: string }): Promise<CollabPeerInfo | number> {
  const docId = docIdFromUrl(request.url)
  if (!docId) return CLOSE_FORBIDDEN

  // No cookie → h3 tries to CREATE a session, which throws outside a main
  // handler ("Cannot initialize a new session"). That's just "anonymous".
  const session = await getUserSession(request).catch(() => null)
  const userId = session?.user?.id
  if (!session || !userId || typeof session.dek !== 'string') return CLOSE_UNAUTHORIZED
  const dek = Buffer.from(session.dek, 'base64')
  if (dek.byteLength !== 32) return CLOSE_UNAUTHORIZED

  try {
    const { document, workspace, role } = await assertDocumentMembership(userId, docId)
    if (
      document.type !== 'markdown'
      || document.deletedAt != null
      || workspace.encryptionMode !== 'wek'
    ) return CLOSE_FORBIDDEN
    const key = await getWorkspaceKeyForUserById(userId, workspace.id, dek)
    if (!key) return CLOSE_FORBIDDEN
    return { userId, docId, canEdit: role !== 'viewer', key }
  }
  catch {
    return CLOSE_FORBIDDEN
  }
}

export default defineWebSocketHandler({
  async upgrade(request) {
    // Never let the upgrade reject: crossws would leave the socket hanging.
    const result = await authorize(request as unknown as Parameters<typeof authorize>[0])
      .catch((err: unknown) => {
        console.error('[collab] authorize failed', err)
        return CLOSE_FORBIDDEN
      })
    if (typeof result === 'number') request.context[CTX_DENIED] = result
    else request.context[CTX_INFO] = result
  },

  async open(peer) {
    const denied = peer.context[CTX_DENIED]
    const info = peer.context[CTX_INFO] as CollabPeerInfo | undefined
    if (typeof denied === 'number' || !info) {
      peer.close(typeof denied === 'number' ? denied : CLOSE_FORBIDDEN, 'denied')
      return
    }
    // Frames can arrive while the room loads; `message` waits on this so the
    // client's opening sync step 1 isn't dropped.
    const joined = joinRoom(peer, info)
    peer.context[CTX_JOINED] = joined
    await joined
  },

  async message(peer, message) {
    const info = peer.context[CTX_INFO] as CollabPeerInfo | undefined
    if (!info) return
    const data = message.uint8Array()
    await (peer.context[CTX_JOINED] as Promise<void> | undefined)
    handleMessage(peer, info.docId, data)
  },

  async close(peer) {
    const info = peer.context[CTX_INFO] as CollabPeerInfo | undefined
    if (!info) return
    await (peer.context[CTX_JOINED] as Promise<void> | undefined)
    await leaveRoom(peer, info.docId)
  },
})
