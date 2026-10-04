/**
 * Thin fetch wrapper around the Mistral REST API.
 * No SDK — keep payloads explicit and typed.
 *
 * Mistral only serves OCR here (plus realtime transcription, proxied in
 * `api/realtime/transcribe.ts`). Generation lives in `./claude.ts`,
 * embeddings in `./embeddings.ts`.
 *
 * Endpoints used:
 *  - POST https://api.mistral.ai/v1/files + /v1/ocr
 */
import { createError } from 'h3'
import { recordProviderSuccess } from './provider-health'
import { logAiUsage } from './ai-usage'

// `useRuntimeConfig` is an auto-imported Nitro helper in server contexts.

function markSuccess(): void {
  try { recordProviderSuccess('mistral') } catch { /* health tracking must never throw */ }
}


/** Map a fetch failure or non-2xx response to a short error code for logs. */
function errorCodeFromStatus(status: number): string {
  return `http_${status}`
}

const MISTRAL_API_BASE = 'https://api.mistral.ai/v1'

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
    logAiUsage(opts?.userId, OCR_MODEL, operation, 0, 0, 0, false, Date.now() - start, 'network')
    throw createError({
      statusCode: 502,
      statusMessage: 'mistral_failed',
      data: { error: 'mistral_failed', detail: (err as Error).message ?? 'network error' },
    })
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    logAiUsage(opts?.userId, OCR_MODEL, operation, 0, 0, 0, false, Date.now() - start, errorCodeFromStatus(res.status))
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
  logAiUsage(opts?.userId, OCR_MODEL, operation, 0, 0, 0, true, Date.now() - start)
  return { markdown, pages }
}
