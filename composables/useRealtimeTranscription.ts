import { ref, type Ref } from 'vue'

/**
 * Realtime voice-to-text against Mistral's `voxtral-mini-transcribe-realtime-latest`.
 *
 * Wire protocol (proxied through `/api/realtime/transcribe` — see
 * server/api/realtime/transcribe.ts):
 *
 *   client → server                     server → client
 *   ───────────────                     ───────────────
 *   {type:"session.update", session:{   {type:"session.created", …}
 *     audio_format:{encoding:"pcm_s16le", {type:"session.updated", …}
 *     sample_rate:16000},               {type:"transcription.text.delta",
 *     target_streaming_delay_ms:1000}}    text:"…"}
 *   {type:"input_audio.append",         {type:"transcription.done"}
 *     audio:"<base64 PCM s16le>"}       {type:"error", error:{…}}
 *   {type:"input_audio.flush"}
 *   {type:"input_audio.end"}
 *
 * Audio path:
 *   getUserMedia → AudioContext(16kHz) → AudioWorklet (pcm-recorder)
 *   → Float32 frames posted to the main thread → Int16 conversion → base64
 *   → WS as `input_audio.append`.
 *
 * The AudioContext is constructed with `sampleRate: 16000` so the worklet
 * receives samples at the rate Mistral wants — no in-JS resampler needed.
 * All evergreen browsers honour that hint.
 */

export type TranscriptionStatus =
  | 'idle'
  | 'requesting-permission'
  | 'connecting'
  | 'recording'
  | 'stopping'
  | 'error'

export interface RealtimeTranscription {
  status: Ref<TranscriptionStatus>
  transcript: Ref<string>
  error: Ref<string | null>
  isRecording: Ref<boolean>
  start: () => Promise<void>
  /** Stop recording and resolve with the final transcript (or null if nothing). */
  stop: () => Promise<string | null>
  /** Tear everything down without yielding a transcript. */
  cancel: () => void
}

// Inline AudioWorklet — registered via Blob URL so we don't ship a static
// asset just for ~20 lines. The processor forwards each render quantum
// (128 samples by default) to the main thread; the main thread accumulates
// and chunks before sending.
const WORKLET_SOURCE = `
class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      // Copy because the underlying buffer is reused on the next quantum.
      this.port.postMessage(input[0].slice(0))
    }
    return true
  }
}
registerProcessor('pcm-recorder', PcmRecorder)
`

// Chunk size in samples sent per `input_audio.append`. 100ms @ 16kHz = 1600
// samples = 3200 bytes — well under the 256 KiB decoded-payload cap.
const CHUNK_SAMPLES = 1600

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    // Clamp + scale. Math.max/min is faster than the ternary chain on V8.
    const s = Math.max(-1, Math.min(1, input[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  // btoa expects a binary string; build it in 8KB blocks so we don't blow
  // the argument-list limit on String.fromCharCode for big chunks.
  let bin = ''
  const block = 0x8000
  for (let i = 0; i < bytes.length; i += block) {
    bin += String.fromCharCode(...bytes.subarray(i, i + block))
  }
  return btoa(bin)
}

export function useRealtimeTranscription(): RealtimeTranscription {
  const status = ref<TranscriptionStatus>('idle')
  const transcript = ref('')
  const error = ref<string | null>(null)
  const isRecording = ref(false)

  let ws: WebSocket | null = null
  let stream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let workletNode: AudioWorkletNode | null = null
  let workletUrl: string | null = null
  let pending: number[] = [] // accumulator before reaching CHUNK_SAMPLES
  let sessionReady = false
  // Buffer of messages waiting on `session.created` (we need to send
  // `session.update` first thing, but `input_audio.append` frames should
  // wait until the upstream session has acked).
  let preSessionAudio: string[] = []
  // Incremented on every cancel(); start() checks this between awaits to
  // bail out cleanly if the user pressed Annuler mid-handshake.
  let cancelToken = 0

  function teardown() {
    isRecording.value = false
    try { workletNode?.port.close() } catch { /* noop */ }
    try { workletNode?.disconnect() } catch { /* noop */ }
    workletNode = null
    try { audioCtx?.close() } catch { /* noop */ }
    audioCtx = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    if (workletUrl) {
      URL.revokeObjectURL(workletUrl)
      workletUrl = null
    }
    pending = []
    preSessionAudio = []
    sessionReady = false
  }

  function closeSocket() {
    if (!ws) return
    try { ws.close() } catch { /* noop */ }
    ws = null
  }

  function sendAudioBase64(b64: string) {
    const frame = JSON.stringify({ type: 'input_audio.append', audio: b64 })
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!sessionReady) {
      preSessionAudio.push(frame)
      return
    }
    ws.send(frame)
  }

  function flushPendingSamples() {
    if (pending.length === 0) return
    const pcm = floatToPcm16(Float32Array.from(pending))
    pending = []
    sendAudioBase64(int16ToBase64(pcm))
  }

  function onWorkletMessage(ev: MessageEvent<Float32Array>) {
    const frame = ev.data
    // Append to the rolling buffer; flush in fixed CHUNK_SAMPLES windows.
    for (let i = 0; i < frame.length; i++) pending.push(frame[i] ?? 0)
    while (pending.length >= CHUNK_SAMPLES) {
      const slice = pending.slice(0, CHUNK_SAMPLES)
      pending = pending.slice(CHUNK_SAMPLES)
      const pcm = floatToPcm16(Float32Array.from(slice))
      sendAudioBase64(int16ToBase64(pcm))
    }
  }

  async function openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const sock = new WebSocket(`${proto}//${location.host}/api/realtime/transcribe`)
      ws = sock

      sock.onopen = () => {
        // Send session.update right away. The server forwards it; Mistral
        // replies with `session.created` (or `.updated`).
        sock.send(JSON.stringify({
          type: 'session.update',
          session: {
            audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 },
            target_streaming_delay_ms: 480,
          },
        }))
        resolve()
      }

      sock.onerror = () => {
        reject(new Error('websocket error'))
      }

      sock.onclose = () => {
        // If the socket dies while we're recording, surface as an error.
        if (status.value === 'recording' || status.value === 'connecting') {
          error.value = 'connection lost'
          status.value = 'error'
          teardown()
        }
      }

      sock.onmessage = (ev) => {
        let msg: { type?: string, text?: string, error?: { message?: { detail?: string } | string } }
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') }
        catch { return }

        switch (msg.type) {
          case 'session.created':
          case 'session.updated': {
            if (!sessionReady) {
              sessionReady = true
              // Drain anything we buffered while we waited.
              for (const frame of preSessionAudio) sock.send(frame)
              preSessionAudio = []
            }
            break
          }
          case 'transcription.text.delta': {
            if (typeof msg.text === 'string') transcript.value += msg.text
            break
          }
          case 'transcription.done': {
            // Server signals end. Don't tear down here — `stop()` handles
            // that — but we know no more deltas will come.
            break
          }
          case 'error': {
            const detail = typeof msg.error?.message === 'string'
              ? msg.error.message
              : msg.error?.message?.detail ?? 'transcription error'
            error.value = detail
            status.value = 'error'
            teardown()
            closeSocket()
            break
          }
        }
      }
    })
  }

  async function start(): Promise<void> {
    if (status.value === 'recording' || status.value === 'connecting') return
    const token = ++cancelToken
    error.value = null
    transcript.value = ''
    status.value = 'requesting-permission'

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          // Mistral wants 16 kHz; ask the browser politely. If it can't
          // honour the constraint, the AudioContext below will resample.
          sampleRate: 16000,
        },
      })
    }
    catch (err) {
      if (token !== cancelToken) return
      error.value = (err as Error).message || 'microphone access denied'
      status.value = 'error'
      return
    }
    if (token !== cancelToken) {
      for (const tr of stream.getTracks()) tr.stop()
      stream = null
      return
    }

    status.value = 'connecting'

    try {
      await openSocket()
    }
    catch (err) {
      if (token !== cancelToken) return
      error.value = (err as Error).message || 'could not connect'
      status.value = 'error'
      teardown()
      return
    }
    if (token !== cancelToken) {
      teardown()
      closeSocket()
      return
    }

    // Audio graph: mic → worklet (no destination — we don't want to hear
    // ourselves echoed back).
    audioCtx = new AudioContext({ sampleRate: 16000 })
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    workletUrl = URL.createObjectURL(blob)
    await audioCtx.audioWorklet.addModule(workletUrl)
    if (token !== cancelToken) {
      teardown()
      closeSocket()
      return
    }

    const source = audioCtx.createMediaStreamSource(stream)
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-recorder')
    workletNode.port.onmessage = onWorkletMessage
    source.connect(workletNode)

    status.value = 'recording'
    isRecording.value = true
  }

  async function stop(): Promise<string | null> {
    if (status.value !== 'recording') {
      // Allow stop() during 'connecting' too — user might have second-thought.
      if (status.value === 'connecting' || status.value === 'requesting-permission') {
        cancel()
      }
      return null
    }

    status.value = 'stopping'
    isRecording.value = false

    // Push any remaining samples so we don't lose the tail.
    flushPendingSamples()

    // Politely close the audio side of the session.
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio.flush' }))
        ws.send(JSON.stringify({ type: 'input_audio.end' }))
      }
    }
    catch { /* noop */ }

    // Wait briefly for any trailing deltas before tearing down. Mistral
    // emits a final delta + `transcription.done` after `input_audio.end`.
    // We resolve on `transcription.done` OR a 3s safety timeout.
    await new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => { if (!resolved) { resolved = true; resolve() } }
      const timer = setTimeout(finish, 3000)
      const prevOnMessage = ws?.onmessage
      if (ws) {
        ws.onmessage = (ev) => {
          prevOnMessage?.call(ws as WebSocket, ev)
          try {
            const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as { type?: string }
            if (m.type === 'transcription.done') {
              clearTimeout(timer)
              finish()
            }
          }
          catch { /* noop */ }
        }
      }
    })

    const result = transcript.value.trim() || null
    teardown()
    closeSocket()
    status.value = 'idle'
    return result
  }

  function cancel() {
    cancelToken++
    isRecording.value = false
    teardown()
    closeSocket()
    transcript.value = ''
    error.value = null
    status.value = 'idle'
  }

  return { status, transcript, error, isRecording, start, stop, cancel }
}
