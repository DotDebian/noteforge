/**
 * Excalidraw document plumbing — shared by the browser editor, the REST layer
 * and the MCP tools.
 *
 * Storage contract for a `documents` row with `type = 'excalidraw'`:
 *
 *   content_json  the `.excalidraw` scene, verbatim. Source of truth. Byte-for
 *                 byte what excalidraw.com imports/exports, so an MCP client
 *                 can round-trip a drawing without a NoteForge-specific format.
 *   markdown      DERIVED, rewritten on every save by `buildDrawingMarkdown`:
 *                 the drawing's text elements in reading order, then a PNG
 *                 data-URL image. Never author it by hand — it exists so that
 *                 search, FTS, RAG, exports (md/html/pdf/docx/zip),
 *                 `![[transclusion]]` and public shares keep working with no
 *                 special-casing.
 *
 * The derived markdown carries a base64 image, which is fine for rendering but
 * ruinous for anything token- or index-shaped. Every path that feeds document
 * markdown to Mistral, to the chunker, to an MCP response or to a search
 * snippet must run it through `stripEmbeddedDataUrls` first.
 *
 * Deliberately dependency-free (no `@excalidraw/excalidraw`, no `h3`, no db) so
 * Nitro, the Vue client and vitest can all import it — same rationale as
 * `server/utils/oauth-policy.ts`.
 */

/* -------------------------------------------------------------------------- */
/*  Scene shape                                                                */
/* -------------------------------------------------------------------------- */

/** The subset of an Excalidraw element this module actually reads. */
export interface ExcalidrawElementLike {
  type?: string
  text?: string
  name?: string
  x?: number
  y?: number
  isDeleted?: boolean
  containerId?: string | null
  [key: string]: unknown
}

export interface ExcalidrawScene {
  type: 'excalidraw'
  version: number
  source: string
  elements: ExcalidrawElementLike[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

export const EXCALIDRAW_SCENE_VERSION = 2
export const EXCALIDRAW_SOURCE = 'noteforge'

export function emptyExcalidrawScene(): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: EXCALIDRAW_SCENE_VERSION,
    source: EXCALIDRAW_SOURCE,
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }
}

/**
 * Structural check. Excalidraw's own `isValidExcalidrawData` lives in the React
 * bundle, which the server can't load — and all we actually need is "does this
 * carry an elements array".
 */
export function isExcalidrawScene(value: unknown): value is ExcalidrawScene {
  if (!value || typeof value !== 'object') return false
  return Array.isArray((value as { elements?: unknown }).elements)
}

/**
 * Parse `documents.content_json` into a scene. Returns `null` — never throws —
 * when the column holds a Tiptap document, `'{}'`, or corrupt JSON, so callers
 * can decide between "start blank" and "refuse the write".
 */
export function parseExcalidrawScene(contentJson: string | null | undefined): ExcalidrawScene | null {
  if (!contentJson) return null
  let data: unknown
  try {
    data = JSON.parse(contentJson) as unknown
  }
  catch {
    return null
  }
  if (!isExcalidrawScene(data)) return null
  const raw = data as Partial<ExcalidrawScene> & { elements: ExcalidrawElementLike[] }
  return {
    type: 'excalidraw',
    version: typeof raw.version === 'number' ? raw.version : EXCALIDRAW_SCENE_VERSION,
    source: typeof raw.source === 'string' ? raw.source : EXCALIDRAW_SOURCE,
    elements: raw.elements,
    appState: (raw.appState && typeof raw.appState === 'object' ? raw.appState : {}) as Record<string, unknown>,
    files: (raw.files && typeof raw.files === 'object' ? raw.files : {}) as Record<string, unknown>,
  }
}

/** Serialize a scene for the `content_json` column. */
export function serializeExcalidrawScene(scene: ExcalidrawScene): string {
  return JSON.stringify(scene)
}

/* -------------------------------------------------------------------------- */
/*  Text extraction                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pull every readable string out of a scene, in rough reading order (top to
 * bottom, then left to right). This is the *only* thing search, FTS and the RAG
 * chunker ever see of a drawing, so it is worth keeping faithful:
 *
 *  - `text` elements cover both free labels and text bound to a shape
 *    (Excalidraw stores bound text as its own element with a `containerId`).
 *  - `frame` elements carry a user-visible `name`.
 *
 * Deleted elements are skipped: Excalidraw tombstones rather than removes, and
 * a deleted sticky note should not keep answering searches.
 */
export function extractSceneText(scene: ExcalidrawScene | null): string[] {
  if (!scene) return []
  const withPos = scene.elements
    .filter(el => el && !el.isDeleted)
    .map((el) => {
      const raw = el.type === 'frame' || el.type === 'magicframe' ? el.name : el.text
      return {
        text: typeof raw === 'string' ? raw.trim() : '',
        x: typeof el.x === 'number' ? el.x : 0,
        y: typeof el.y === 'number' ? el.y : 0,
      }
    })
    .filter(e => e.text.length > 0)

  // Bucket y into 20px bands before sorting so that labels sitting on the same
  // visual row don't get interleaved by sub-pixel differences.
  withPos.sort((a, b) => {
    const bandA = Math.round(a.y / 20)
    const bandB = Math.round(b.y / 20)
    if (bandA !== bandB) return bandA - bandB
    return a.x - b.x
  })

  return withPos.map(e => e.text)
}

/* -------------------------------------------------------------------------- */
/*  Derived markdown                                                           */
/* -------------------------------------------------------------------------- */

export interface BuildDrawingMarkdownInput {
  scene: ExcalidrawScene | null
  /** PNG data URL rendered by the browser. Empty when the writer is headless. */
  preview?: string
  /** Used as the image's alt text. */
  title?: string
}

/**
 * Build the `markdown` mirror of a drawing.
 *
 * Text comes FIRST and the image last, on purpose: the workspace search builds
 * its fallback snippet from the first ~220 characters of the markdown, and a
 * base64 blob there would render the snippet useless.
 */
export function buildDrawingMarkdown(input: BuildDrawingMarkdownInput): string {
  const lines = extractSceneText(input.scene)
  const alt = (input.title ?? '').trim() || 'Excalidraw'
  const parts: string[] = []
  if (lines.length > 0) parts.push(lines.join('\n\n'))
  if (input.preview) parts.push(`![${escapeAltText(alt)}](${input.preview})`)
  return parts.join('\n\n')
}

function escapeAltText(alt: string): string {
  return alt.replace(/[[\]]/g, '')
}

/* -------------------------------------------------------------------------- */
/*  Data-URL stripping                                                         */
/* -------------------------------------------------------------------------- */

/** Placeholder left behind so a stripped body never looks accidentally empty. */
export const STRIPPED_IMAGE_PLACEHOLDER = '[image]'

/**
 * Remove embedded base64 payloads from a markdown body while keeping the prose.
 *
 * Applied before: the Mistral analysis prompt, chunking/embedding, MCP tool
 * responses and search snippets. A 720px PNG data URL runs ~50-150 KB — left in
 * place it would dominate an embedding, blow out a tool response, and flood the
 * FTS index with base64 tokens.
 *
 * Covers the three shapes a data URL reaches markdown through: a markdown
 * image, an inline `<img>`, and the `data-preview` attribute of a legacy
 * in-note whiteboard block.
 */
export function stripEmbeddedDataUrls(markdown: string): string {
  if (!markdown || !markdown.includes('data:')) return markdown
  return markdown
    // ![alt](data:image/png;base64,…)
    .replace(/!\[([^\]\n]*)\]\(\s*data:[^)]*\)/g, (_m, alt: string) =>
      alt.trim() ? `[${alt.trim()}]` : STRIPPED_IMAGE_PLACEHOLDER)
    // <img src="data:…" …>
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']data:[^"']*["'][^>]*>/gi, STRIPPED_IMAGE_PLACEHOLDER)
    // legacy whiteboard block: keep the element, drop the payload
    .replace(/(\bdata-(?:preview|scene)\s*=\s*")[^"]*(")/gi, '$1$2')
}

/**
 * True when the body is nothing but stripped-image placeholders and whitespace
 * — i.e. a drawing with no text in it. Callers use this to skip an AI analysis
 * that would have nothing to chew on.
 */
export function isEffectivelyEmptyForAi(markdown: string): boolean {
  const stripped = stripEmbeddedDataUrls(markdown)
    .split(STRIPPED_IMAGE_PLACEHOLDER).join(' ')
    .replace(/<[^>]*>/g, ' ')
    .trim()
  return stripped.length === 0
}
