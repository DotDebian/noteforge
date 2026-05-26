/**
 * WebSocket proxy → Mistral realtime transcription.
 *
 * The browser cannot connect to `wss://api.mistral.ai/...` directly because
 * the Mistral API key would leak in the URL/headers. So we bridge:
 *
 *     browser  <──ws──>  Nitro  <──wss──>  Mistral
 *
 * Each peer opens an outbound WS to Mistral and forwards JSON messages in
 * both directions verbatim. The browser is responsible for the protocol:
 * `session.update`, `input_audio.append`, `input_audio.flush`,
 * `input_audio.end`. See server/utils/mistral.ts for the parent fetch
 * helpers; we don't go through them here because they don't speak WS.
 */
import WebSocket from 'ws'

const MISTRAL_REALTIME_URL
  = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime'
// `-latest` alias appears not to be wired up yet for voxtral realtime; the
// dated snapshot is the one Mistral's own docs/SDK use as default.
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-2602'

interface PeerCtx {
  upstream?: WebSocket
  // Buffer client frames that arrive before the upstream is open. The
  // browser may push `session.update` immediately after `onopen` — if our
  // upstream is still mid-handshake, we'd drop the frame.
  pending: string[]
}

export default defineWebSocketHandler({
  upgrade(req) {
    // Same-origin only: prevents random pages from burning our Mistral quota.
    // Server-side fetches are fine (no Origin header), but cross-origin
    // browser WS opens always carry one.
    const origin = req.headers.get('origin')
    const host = req.headers.get('host')
    if (origin && host && !origin.endsWith(host)) {
      return new Response('forbidden', { status: 403 })
    }
    // Minimal cookie-presence check — full session validation in WS upgrade
    // hooks would require pulling the nuxt-auth-utils seal logic out into a
    // shared helper, which we can do later. The Origin check above is the
    // load-bearing one.
    const cookie = req.headers.get('cookie') ?? ''
    if (!/nuxt-session=/.test(cookie)) {
      return new Response('unauthorized', { status: 401 })
    }
  },

  open(peer) {
    const cfg = useRuntimeConfig()
    const apiKey = cfg.mistralApiKey as string
    if (!apiKey) {
      peer.send(JSON.stringify({ type: 'error', error: { message: { detail: 'MISTRAL_API_KEY not configured' } } }))
      peer.close()
      return
    }

    const url = `${MISTRAL_REALTIME_URL}?model=${encodeURIComponent(DEFAULT_MODEL)}`
    const upstream = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    const ctx: PeerCtx = { upstream, pending: [] }
    ;(peer as unknown as { ctx: PeerCtx }).ctx = ctx

    upstream.on('open', () => {
      // Drain anything the client tried to send while we were connecting.
      for (const msg of ctx.pending) upstream.send(msg)
      ctx.pending.length = 0
    })

    upstream.on('message', (data) => {
      // Mistral sends JSON text frames. Pass through as-is.
      const text = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8')
      try { peer.send(text) }
      catch { /* peer already closed */ }
    })

    upstream.on('close', (code, reason) => {
      try { peer.close(code, reason?.toString() || undefined) }
      catch { /* already closed */ }
    })

    upstream.on('unexpected-response', (_req, res) => {
      // Mistral rejected the upgrade. Read the body so the browser sees
      // the real reason (model not allowed, key out of beta, …).
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 500)
        const detail = `upstream ${res.statusCode}: ${body || res.statusMessage || ''}`
        console.error('[realtime] upstream rejected handshake', detail)
        try {
          peer.send(JSON.stringify({ type: 'error', error: { message: { detail } } }))
          peer.close()
        }
        catch { /* already closed */ }
      })
    })

    upstream.on('error', (err) => {
      console.error('[realtime] upstream error', err)
      try {
        peer.send(JSON.stringify({
          type: 'error',
          error: { message: { detail: (err as Error).message ?? 'upstream error' } },
        }))
        peer.close()
      }
      catch { /* already closed */ }
    })
  },

  message(peer, message) {
    const ctx = (peer as unknown as { ctx?: PeerCtx }).ctx
    if (!ctx?.upstream) return

    // Browser always sends JSON strings (session.update, input_audio.append, …).
    // Coerce any binary frame to text for safety.
    const text = typeof message === 'string'
      ? message
      : 'text' in message && typeof message.text === 'function'
        ? message.text()
        : String(message)

    if (ctx.upstream.readyState === WebSocket.OPEN) {
      ctx.upstream.send(text)
    }
    else if (ctx.upstream.readyState === WebSocket.CONNECTING) {
      ctx.pending.push(text)
    }
  },

  close(peer) {
    const ctx = (peer as unknown as { ctx?: PeerCtx }).ctx
    try { ctx?.upstream?.close() }
    catch { /* noop */ }
  },

  error(peer, _error) {
    const ctx = (peer as unknown as { ctx?: PeerCtx }).ctx
    try { ctx?.upstream?.close() }
    catch { /* noop */ }
  },
})
