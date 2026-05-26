/**
 * Streamed selection rewrite via `/api/ai/transform`.
 *
 * Usage:
 *   const t = useAiTransform()
 *   for await (const delta of t.stream('improve', text)) { ... }
 *
 * Each SSE `data: {type:"delta",text:"…"}` frame yields a string. The
 * generator returns on `done` and throws on `error`.
 */
export type AiAction =
  | 'improve'
  | 'summarize'
  | 'translate'
  | 'continue'
  | 'explain'
  | 'tone'

export interface AiTransformOptions {
  /** Target language (translate) or target tone (tone). */
  option?: string
  /** Abort the in-flight request — pass through the same controller. */
  signal?: AbortSignal
}

export function useAiTransform() {
  async function* stream(
    action: AiAction,
    text: string,
    opts: AiTransformOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const res = await fetch('/api/ai/transform', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ action, text, option: opts.option }),
      signal: opts.signal,
    })

    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`
      try {
        const data = await res.json() as { statusMessage?: string, data?: { detail?: string } }
        detail = data?.data?.detail ?? data?.statusMessage ?? detail
      }
      catch { /* ignore */ }
      throw new Error(detail)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        let sep = buf.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          sep = buf.indexOf('\n\n')

          const payload = frame
            .split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())
            .join('\n')
          if (!payload) continue

          let event: { type?: string, text?: string, detail?: string }
          try { event = JSON.parse(payload) }
          catch { continue }

          if (event.type === 'delta' && typeof event.text === 'string') {
            yield event.text
          }
          else if (event.type === 'done') {
            return
          }
          else if (event.type === 'error') {
            throw new Error(event.detail || 'transform_failed')
          }
        }
      }
    }
    finally {
      try { reader.releaseLock() } catch { /* noop */ }
    }
  }

  return { stream }
}
