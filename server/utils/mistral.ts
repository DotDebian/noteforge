/**
 * Thin fetch wrapper around the Mistral REST API.
 * No SDK — keep payloads explicit and typed.
 *
 * Endpoints used:
 *  - POST https://api.mistral.ai/v1/chat/completions
 *  - POST https://api.mistral.ai/v1/embeddings
 */
import { createError } from 'h3'
import { recordMistralSuccess } from './mistral-health'
import { useDb } from '~/server/database/client'
import { aiUsageLogs } from '~/server/database/schema'

// `useRuntimeConfig` is an auto-imported Nitro helper in server contexts.

function markSuccess(): void {
  try { recordMistralSuccess() } catch { /* health tracking must never throw */ }
}

function logMistralUsage(
  userId: number | undefined,
  model: string,
  operation: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): void {
  if (!userId) return
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(aiUsageLogs).values({ userId, model, operation, promptTokens, completionTokens, totalTokens })
    }
    catch { /* never surface logging errors */ }
  })
}

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1'

export type MistralRole = 'system' | 'user' | 'assistant'

export interface MistralMessage {
  role: MistralRole
  content: string
}

interface MistralChatChoice {
  index: number
  message: { role: MistralRole, content: string }
  finish_reason: string | null
}

interface MistralChatResponse {
  id: string
  model: string
  choices: MistralChatChoice[]
  usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number }
}

interface MistralStreamDelta {
  role?: MistralRole
  content?: string
}

interface MistralStreamChoice {
  index: number
  delta: MistralStreamDelta
  finish_reason: string | null
}

interface MistralStreamChunk {
  id: string
  choices: MistralStreamChoice[]
  usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number }
}

interface MistralEmbeddingItem {
  index: number
  embedding: number[]
}

interface MistralEmbeddingResponse {
  id: string
  model: string
  data: MistralEmbeddingItem[]
  usage?: { prompt_tokens: number, total_tokens: number }
}

interface MistralErrorPayload {
  message?: string
  type?: string
}

function getApiKey(): string {
  const cfg = useRuntimeConfig()
  const key = cfg.mistralApiKey
  if (!key || typeof key !== 'string') {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: 'MISTRAL_API_KEY is not configured' },
    })
  }
  return key
}

function getChatModel(override?: string): string {
  if (override) return override
  const cfg = useRuntimeConfig()
  return (cfg.mistralChatModel as string) || 'mistral-large-latest'
}

function getEmbedModel(override?: string): string {
  if (override) return override
  const cfg = useRuntimeConfig()
  return (cfg.mistralEmbedModel as string) || 'mistral-embed'
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const parsed = JSON.parse(text) as { error?: MistralErrorPayload, message?: string }
      return parsed.error?.message ?? parsed.message ?? text
    }
    catch {
      return text
    }
  }
  catch {
    return `HTTP ${res.status}`
  }
}

/* -------------------------------------------------------------------------- */
/*  Non-streaming chat                                                         */
/* -------------------------------------------------------------------------- */

export interface MistralChatOptions {
  messages: MistralMessage[]
  jsonMode?: boolean
  temperature?: number
  model?: string
  userId?: number
  operation?: string
}

export async function mistralChat(opts: MistralChatOptions): Promise<{ content: string }> {
  const apiKey = getApiKey()
  const body: Record<string, unknown> = {
    model: getChatModel(opts.model),
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  let res: Response
  try {
    res = await fetch(`${MISTRAL_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const json = (await res.json()) as MistralChatResponse
  const content = json.choices[0]?.message?.content
  if (typeof content !== 'string') {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: 'Empty Mistral response' },
    })
  }
  markSuccess()
  if (json.usage) {
    logMistralUsage(opts.userId, getChatModel(opts.model), opts.operation ?? 'chat',
      json.usage.prompt_tokens, json.usage.completion_tokens, json.usage.total_tokens)
  }
  return { content }
}

/* -------------------------------------------------------------------------- */
/*  Streaming chat (SSE)                                                       */
/* -------------------------------------------------------------------------- */

export interface MistralStreamOptions {
  messages: MistralMessage[]
  temperature?: number
  model?: string
  userId?: number
  operation?: string
}

/**
 * Async generator yielding text deltas (`choices[0].delta.content` fragments).
 * Throws a 502 createError if the upstream fails.
 */
export async function* mistralChatStream(
  opts: MistralStreamOptions,
): AsyncGenerator<string, void, unknown> {
  const apiKey = getApiKey()
  const body = {
    model: getChatModel(opts.model),
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    stream: true,
    stream_options: { include_usage: true },
  }

  let res: Response
  try {
    res = await fetch(`${MISTRAL_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok || !res.body) {
    const detail = res.body ? await readErrorDetail(res) : `HTTP ${res.status}`
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let capturedUsage: MistralStreamChunk['usage'] | undefined

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; each frame can have multiple
      // `data:` prefixed lines (Mistral typically sends one per chunk).
      let sepIdx = buf.indexOf('\n\n')
      while (sepIdx !== -1) {
        const frame = buf.slice(0, sepIdx)
        buf = buf.slice(sepIdx + 2)
        sepIdx = buf.indexOf('\n\n')

        const dataLines: string[] = []
        for (const rawLine of frame.split('\n')) {
          const line = rawLine.trimEnd()
          if (!line.startsWith('data:')) continue
          dataLines.push(line.slice(5).trimStart())
        }
        if (dataLines.length === 0) continue

        const payload = dataLines.join('\n')
        if (payload === '[DONE]') {
          markSuccess()
          if (capturedUsage) {
            logMistralUsage(opts.userId, getChatModel(opts.model), opts.operation ?? 'chat_stream',
              capturedUsage.prompt_tokens, capturedUsage.completion_tokens, capturedUsage.total_tokens)
          }
          return
        }

        try {
          const parsed = JSON.parse(payload) as MistralStreamChunk
          if (parsed.usage) capturedUsage = parsed.usage
          const delta = parsed.choices[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            yield delta
          }
        }
        catch {
          // ignore malformed frames; Mistral occasionally sends keepalives.
        }
      }
    }
  }
  finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

/* -------------------------------------------------------------------------- */
/*  Embeddings                                                                 */
/* -------------------------------------------------------------------------- */

export async function mistralEmbed(
  inputs: string[],
  opts?: string | { model?: string, userId?: number, operation?: string },
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const apiKey = getApiKey()
  const embedOpts = typeof opts === 'string' ? { model: opts } : (opts ?? {})

  let res: Response
  try {
    res = await fetch(`${MISTRAL_API_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ model: getEmbedModel(embedOpts.model), input: inputs }),
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const json = (await res.json()) as MistralEmbeddingResponse
  // Re-order by index just in case the API doesn't guarantee order.
  const out: number[][] = new Array(inputs.length)
  for (const item of json.data) {
    if (item.index >= 0 && item.index < inputs.length) {
      out[item.index] = item.embedding
    }
  }
  // Fill any missing slots (shouldn't happen) with empty arrays so the caller
  // still gets a well-shaped result; downstream code can detect via length.
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out[i] = []
  }
  markSuccess()
  if (json.usage) {
    logMistralUsage(embedOpts.userId, getEmbedModel(embedOpts.model), embedOpts.operation ?? 'embed',
      json.usage.prompt_tokens, 0, json.usage.total_tokens)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  OCR — document → markdown via /v1/files + /v1/ocr                          */
/* -------------------------------------------------------------------------- */

interface MistralFileUploadResponse {
  id: string
  object: string
  bytes: number
  filename: string
  purpose: string
}

interface MistralFileSignedUrlResponse {
  url: string
  expires_at?: string
}

export interface MistralOcrPage {
  index: number
  markdown: string
}

interface MistralOcrResponse {
  pages: MistralOcrPage[]
  model?: string
}

const OCR_MODEL = 'mistral-ocr-latest'

/**
 * Upload a file to Mistral's Files API with `purpose=ocr` and return the
 * resulting file id. Uses native FormData (Node 24+ runtime).
 */
export async function mistralUploadFile(
  filename: string,
  bytes: Uint8Array | Buffer,
  mime: string,
): Promise<string> {
  const apiKey = getApiKey()
  const form = new FormData()
  // Wrap bytes in a Blob with the proper MIME so the upstream stores it as
  // the right kind (PDF vs image vs …). Using a fresh Uint8Array copy avoids
  // shared-buffer issues if the caller passes a slice.
  const u8 = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes)
  form.append('file', new Blob([u8], { type: mime || 'application/octet-stream' }), filename)
  form.append('purpose', 'ocr')

  let res: Response
  try {
    res = await fetch(`${MISTRAL_API_BASE}/files`, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type: fetch sets the multipart boundary itself.
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      body: form,
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const json = (await res.json()) as MistralFileUploadResponse
  if (!json.id) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: 'No file id in upload response' },
    })
  }
  markSuccess()
  return json.id
}

/**
 * Get a short-lived signed URL for an uploaded file. The OCR endpoint accepts
 * a `document_url` or `image_url`, both of which require a fetchable URL.
 */
export async function mistralFileSignedUrl(
  fileId: string,
  expiryHours = 1,
): Promise<string> {
  const apiKey = getApiKey()
  const url = `${MISTRAL_API_BASE}/files/${encodeURIComponent(fileId)}/url?expiry=${expiryHours}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const json = (await res.json()) as MistralFileSignedUrlResponse
  if (!json.url) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: 'No signed url in response' },
    })
  }
  return json.url
}

/**
 * Run OCR on a signed Mistral file URL. Pass `kind: 'image'` for raster
 * images, otherwise the document URL path is used (PDFs and similar).
 * Returns the concatenated page markdown plus the raw page list.
 */
export async function mistralOcr(
  signedUrl: string,
  kind: 'document' | 'image' = 'document',
): Promise<{ markdown: string, pages: MistralOcrPage[] }> {
  const apiKey = getApiKey()
  const document = kind === 'image'
    ? { type: 'image_url' as const, image_url: signedUrl }
    : { type: 'document_url' as const, document_url: signedUrl }

  let res: Response
  try {
    res = await fetch(`${MISTRAL_API_BASE}/ocr`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        document,
        include_image_base64: false,
      }),
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const json = (await res.json()) as MistralOcrResponse
  const pages = Array.isArray(json.pages) ? json.pages : []
  // Stitch pages: blank line between, drop leading/trailing whitespace.
  const markdown = pages
    .map(p => (typeof p.markdown === 'string' ? p.markdown : ''))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  markSuccess()
  return { markdown, pages }
}
