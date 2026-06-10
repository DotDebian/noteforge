/**
 * Web search via Tavily (`POST https://api.tavily.com/search`).
 *
 * Replaces the previous Mistral `/v1/conversations` `web_search` connector,
 * whose response shape kept drifting. Tavily returns a flat, documented JSON
 * body: `{ results: [{ title, url, content, score }], answer? }`.
 *
 * Only the query leaves NoteForge here — never note content — matching the
 * at-rest threat model. Failure-soft: any error returns `{ hits: [], debug }`
 * so the chat turn still answers from notes.
 */

export interface WebHit {
  title: string
  url: string
  snippet: string
}

/** Surfaced to the client so the user can paste it back when search misbehaves. */
export interface WebSearchDebug {
  endpoint: string
  provider: string
  status: number | null
  error?: string
  rawSample?: string
}

interface TavilyResult {
  title?: string
  url?: string
  content?: string
  score?: number
  raw_content?: string | null
}

interface TavilyResponse {
  query?: string
  answer?: string | null
  results?: TavilyResult[]
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

export interface TavilySearchOptions {
  /** Max results to keep. Tavily accepts 0-20; we keep this small. */
  maxResults?: number
  /** `basic` (default) is fast/cheap; `advanced` is slower but richer. */
  searchDepth?: 'basic' | 'advanced'
}

/**
 * Run a one-shot Tavily search. Returns up to `maxResults` hits plus a debug
 * blob describing the call. Never throws.
 */
export async function tavilySearch(
  query: string,
  opts: TavilySearchOptions = {},
): Promise<{ hits: WebHit[], debug: WebSearchDebug }> {
  const maxResults = opts.maxResults ?? 4
  const debug: WebSearchDebug = {
    endpoint: TAVILY_ENDPOINT,
    provider: 'tavily',
    status: null,
  }

  const trimmed = query.trim()
  if (trimmed.length === 0) {
    debug.error = 'empty query'
    return { hits: [], debug }
  }

  const cfg = useRuntimeConfig()
  const apiKey = cfg.tavilyApiKey as string | undefined
  if (!apiKey || typeof apiKey !== 'string') {
    debug.error = 'TAVILY_API_KEY missing'
    return { hits: [], debug }
  }

  const start = Date.now()
  let res: Response
  try {
    res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        query: trimmed,
        search_depth: opts.searchDepth ?? 'basic',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
    })
  }
  catch (err) {
    debug.error = `network: ${(err as Error).message ?? 'unknown'}`
    console.warn('[web-search] tavily network error:', debug.error)
    return { hits: [], debug }
  }

  debug.status = res.status

  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch { /* noop */ }
    debug.error = body ? `HTTP ${res.status}: ${body.slice(0, 240)}` : `HTTP ${res.status}`
    console.warn(`[web-search] tavily ${res.status} (${Date.now() - start}ms):`, body.slice(0, 500))
    return { hits: [], debug }
  }

  let json: TavilyResponse
  try {
    json = (await res.json()) as TavilyResponse
  }
  catch (err) {
    debug.error = `parse: ${(err as Error).message ?? 'unknown'}`
    return { hits: [], debug }
  }

  try {
    debug.rawSample = JSON.stringify(json).slice(0, 4000)
  }
  catch { /* circular shouldn't happen on plain JSON */ }

  const hits: WebHit[] = []
  const seenUrls = new Set<string>()
  for (const r of json.results ?? []) {
    if (hits.length >= maxResults) break
    const url = typeof r.url === 'string' ? r.url : ''
    if (url.length === 0 || seenUrls.has(url)) continue
    seenUrls.add(url)
    hits.push({
      title: typeof r.title === 'string' && r.title.length > 0 ? r.title : safeHost(url),
      url,
      snippet: typeof r.content === 'string' ? r.content : '',
    })
  }

  if (hits.length === 0) {
    debug.error = debug.error ?? 'no results'
  }
  return { hits, debug }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname }
  catch { return url.slice(0, 40) }
}

/* -------------------------------------------------------------------------- */
/*  Extract — full page content for a small set of URLs                        */
/* -------------------------------------------------------------------------- */

const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract'

interface TavilyExtractResult {
  url?: string
  title?: string
  raw_content?: string | null
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[]
  failed_results?: Array<{ url?: string, error?: string }>
}

/**
 * Pull the full cleaned page content for up to a handful of URLs via Tavily's
 * `/extract` endpoint. Returns a `url → markdown content` map for whatever
 * succeeded (failures are simply absent). Never throws — on any error the map
 * is empty and the caller falls back to the search snippets.
 */
export async function tavilyExtract(
  urls: string[],
): Promise<{ byUrl: Map<string, string>, debug: WebSearchDebug }> {
  const byUrl = new Map<string, string>()
  const debug: WebSearchDebug = {
    endpoint: TAVILY_EXTRACT_ENDPOINT,
    provider: 'tavily-extract',
    status: null,
  }

  const targets = urls.filter(u => typeof u === 'string' && u.length > 0)
  if (targets.length === 0) {
    debug.error = 'no urls'
    return { byUrl, debug }
  }

  const cfg = useRuntimeConfig()
  const apiKey = cfg.tavilyApiKey as string | undefined
  if (!apiKey || typeof apiKey !== 'string') {
    debug.error = 'TAVILY_API_KEY missing'
    return { byUrl, debug }
  }

  const start = Date.now()
  let res: Response
  try {
    res = await fetch(TAVILY_EXTRACT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        urls: targets,
        extract_depth: 'basic',
        format: 'markdown',
      }),
    })
  }
  catch (err) {
    debug.error = `network: ${(err as Error).message ?? 'unknown'}`
    console.warn('[web-search] tavily extract network error:', debug.error)
    return { byUrl, debug }
  }

  debug.status = res.status

  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch { /* noop */ }
    debug.error = body ? `HTTP ${res.status}: ${body.slice(0, 240)}` : `HTTP ${res.status}`
    console.warn(`[web-search] tavily extract ${res.status} (${Date.now() - start}ms):`, body.slice(0, 500))
    return { byUrl, debug }
  }

  let json: TavilyExtractResponse
  try {
    json = (await res.json()) as TavilyExtractResponse
  }
  catch (err) {
    debug.error = `parse: ${(err as Error).message ?? 'unknown'}`
    return { byUrl, debug }
  }

  for (const r of json.results ?? []) {
    if (typeof r.url !== 'string' || r.url.length === 0) continue
    const content = typeof r.raw_content === 'string' ? r.raw_content.trim() : ''
    if (content.length > 0) byUrl.set(r.url, content)
  }

  if (byUrl.size === 0) {
    debug.error = debug.error ?? 'no content extracted'
  }
  return { byUrl, debug }
}
