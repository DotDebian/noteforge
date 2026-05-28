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
  success: boolean = true,
  latencyMs?: number,
  errorCode?: string,
): void {
  // We still log unauthenticated calls when they FAIL so error rates surface
  // in the admin panel; successful unauthenticated calls don't have a useful
  // owner and are skipped.
  if (!userId && success) return
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(aiUsageLogs).values({
        userId: userId ?? null,
        model,
        operation,
        promptTokens,
        completionTokens,
        totalTokens,
        success,
        latencyMs: latencyMs ?? null,
        errorCode: errorCode ?? null,
      })
    }
    catch { /* never surface logging errors */ }
  })
}

/** Map a fetch failure or non-2xx response to a short error code for logs. */
function errorCodeFromStatus(status: number): string {
  return `http_${status}`
}

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1'

export type MistralRole = 'system' | 'user' | 'assistant'

/**
 * Content parts accepted by Mistral chat completions on vision models
 * (Pixtral et al). A user message can carry an array mixing text + image
 * parts; other roles still use plain strings.
 */
export type MistralMessageContentPart =
  | { type: 'text', text: string }
  | { type: 'image_url', image_url: string }

export interface MistralMessage {
  role: MistralRole
  /**
   * Most messages are plain strings. User messages with an attached image
   * use the array form so Mistral routes them to the vision pipeline.
   */
  content: string | MistralMessageContentPart[]
}

/**
 * Mistral chat message content. When tools (e.g. web_search) fire the API
 * sometimes returns an array of TextChunk / ToolReference fragments instead
 * of a plain string. We keep this as `unknown` and let callers narrow.
 */
export type MistralChoiceContent = string | Array<Record<string, unknown>> | null

interface MistralChatChoice {
  index: number
  message: { role: MistralRole, content: MistralChoiceContent, tool_calls?: Array<Record<string, unknown>> }
  finish_reason: string | null
}

interface MistralChatResponse {
  id: string
  model: string
  choices: MistralChatChoice[]
  usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number }
}

/**
 * Typed content chunk for tool-enabled chat completions. Mistral may stream a
 * `content` array of these fragments instead of a plain string when web_search
 * (or similar tools) is active.
 */
export type MistralContentChunk =
  | { type: 'text', text: string }
  | {
    type: 'reference'
    reference_ids?: number[]
    references?: Array<{
      id?: number
      url?: string
      title?: string
      snippet?: string
      source_type?: string
    }>
  }

/**
 * Discriminated event yielded by `mistralChatStream`. Text events carry an
 * incremental delta; reference events carry a (possibly partial) list of
 * source references the model wants to cite.
 */
export type MistralStreamEvent =
  | { kind: 'text', text: string }
  | {
    kind: 'reference'
    refs: Array<{
      id?: number
      url?: string
      title?: string
      snippet?: string
    }>
  }

interface MistralStreamDelta {
  role?: MistralRole
  /** Either a plain string (legacy) or an array of typed content chunks. */
  content?: string | MistralContentChunk[]
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
  return (cfg.mistralChatModel as string) || 'mistral-medium-latest'
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
  /**
   * Mistral tool descriptors. We pass them through verbatim — the most
   * common use today is `[{ type: 'web_search' }]` for the web-fallback flow.
   */
  tools?: Array<Record<string, unknown>>
  /** Forwarded to `tool_choice` on the request body. */
  toolChoice?: string | Record<string, unknown>
}

export async function mistralChat(opts: MistralChatOptions): Promise<{ content: string, raw?: MistralChatResponse }> {
  const apiKey = getApiKey()
  const model = getChatModel(opts.model)
  const operation = opts.operation ?? 'chat'
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice
  }

  const start = Date.now()
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
    logMistralUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, 'network')
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    logMistralUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, errorCodeFromStatus(res.status))
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail },
    })
  }

  const json = (await res.json()) as MistralChatResponse
  const rawContent = json.choices[0]?.message?.content
  // With tools (web_search etc.) Mistral may return an array of fragments
  // instead of a plain string. We flatten string fragments to keep the
  // simple `content: string` contract for callers that don't care; tool
  // consumers should reach into `raw` to walk the structured content.
  let content: string
  if (typeof rawContent === 'string') {
    content = rawContent
  }
  else if (Array.isArray(rawContent)) {
    content = rawContent
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text
        }
        return ''
      })
      .join('')
  }
  else {
    content = ''
  }
  if (!opts.tools && content.length === 0) {
    // Without tools an empty content is a hard failure (the old contract).
    // With tools, the message may carry only tool refs — that's fine.
    logMistralUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, 'empty_response')
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: 'Empty Mistral response' },
    })
  }
  markSuccess()
  const latencyMs = Date.now() - start
  if (json.usage) {
    logMistralUsage(opts.userId, model, operation,
      json.usage.prompt_tokens, json.usage.completion_tokens, json.usage.total_tokens,
      true, latencyMs)
  }
  else {
    logMistralUsage(opts.userId, model, operation, 0, 0, 0, true, latencyMs)
  }
  return { content, raw: json }
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
  /** Tool descriptors forwarded verbatim (e.g. `[{ type: 'web_search' }]`). */
  tools?: Array<Record<string, unknown>>
  toolChoice?: string | Record<string, unknown>
}

/**
 * Async generator yielding discriminated stream events. Plain string deltas
 * are wrapped as `{kind:'text', text}`; tool-enabled completions can also
 * surface `{kind:'reference', refs}` events for native source citations.
 * Throws a 502 createError if the upstream fails.
 */
export async function* mistralChatStream(
  opts: MistralStreamOptions,
): AsyncGenerator<MistralStreamEvent, void, unknown> {
  const apiKey = getApiKey()
  const model = getChatModel(opts.model)
  const operation = opts.operation ?? 'chat_stream'
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice
  }

  const start = Date.now()
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
    logMistralUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, 'network')
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok || !res.body) {
    const detail = res.body ? await readErrorDetail(res) : `HTTP ${res.status}`
    logMistralUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, errorCodeFromStatus(res.status))
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
          const latencyMs = Date.now() - start
          if (capturedUsage) {
            logMistralUsage(opts.userId, model, operation,
              capturedUsage.prompt_tokens, capturedUsage.completion_tokens, capturedUsage.total_tokens,
              true, latencyMs)
          }
          else {
            logMistralUsage(opts.userId, model, operation, 0, 0, 0, true, latencyMs)
          }
          return
        }

        try {
          const parsed = JSON.parse(payload) as MistralStreamChunk
          if (parsed.usage) capturedUsage = parsed.usage
          const delta = parsed.choices[0]?.delta?.content
          if (typeof delta === 'string') {
            if (delta.length > 0) yield { kind: 'text', text: delta }
          }
          else if (Array.isArray(delta)) {
            for (const part of delta) {
              if (!part || typeof part !== 'object' || !('type' in part)) continue
              if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
                yield { kind: 'text', text: part.text }
              }
              else if (part.type === 'reference') {
                const refs: Array<{ id?: number, url?: string, title?: string, snippet?: string }> = []
                // Either `reference_ids` (bare numeric IDs) OR a list of
                // structured `references`. Pass everything through; the
                // caller decides what to match against its source list.
                if (Array.isArray(part.reference_ids)) {
                  for (const id of part.reference_ids) {
                    if (typeof id === 'number') refs.push({ id })
                  }
                }
                if (Array.isArray(part.references)) {
                  for (const r of part.references) {
                    if (!r || typeof r !== 'object') continue
                    refs.push({
                      ...(typeof r.id === 'number' ? { id: r.id } : {}),
                      ...(typeof r.url === 'string' ? { url: r.url } : {}),
                      ...(typeof r.title === 'string' ? { title: r.title } : {}),
                      ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
                    })
                  }
                }
                if (refs.length > 0) yield { kind: 'reference', refs }
              }
            }
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
  const model = getEmbedModel(embedOpts.model)
  const operation = embedOpts.operation ?? 'embed'

  const start = Date.now()
  let res: Response
  try {
    res = await fetch(`${MISTRAL_API_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ model, input: inputs }),
    })
  }
  catch (err) {
    logMistralUsage(embedOpts.userId, model, operation, 0, 0, 0, false, Date.now() - start, 'network')
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    logMistralUsage(embedOpts.userId, model, operation, 0, 0, 0, false, Date.now() - start, errorCodeFromStatus(res.status))
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
  const latencyMs = Date.now() - start
  if (json.usage) {
    logMistralUsage(embedOpts.userId, model, operation,
      json.usage.prompt_tokens, 0, json.usage.total_tokens, true, latencyMs)
  }
  else {
    logMistralUsage(embedOpts.userId, model, operation, 0, 0, 0, true, latencyMs)
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
  opts?: { userId?: number, operation?: string },
): Promise<{ markdown: string, pages: MistralOcrPage[] }> {
  const apiKey = getApiKey()
  const operation = opts?.operation ?? 'ocr'
  const document = kind === 'image'
    ? { type: 'image_url' as const, image_url: signedUrl }
    : { type: 'document_url' as const, document_url: signedUrl }

  const start = Date.now()
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
    logMistralUsage(opts?.userId, OCR_MODEL, operation, 0, 0, 0, false, Date.now() - start, 'network')
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    logMistralUsage(opts?.userId, OCR_MODEL, operation, 0, 0, 0, false, Date.now() - start, errorCodeFromStatus(res.status))
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
  logMistralUsage(opts?.userId, OCR_MODEL, operation, 0, 0, 0, true, Date.now() - start)
  return { markdown, pages }
}
