/**
 * Section-aware markdown chunker (Sprint 3 / I2).
 *
 * Strategy:
 *  1. Pre-pass over the source line-by-line, tracking a `# heading` stack and a
 *     `inCodeFence` flag (so triple-backtick fences are atomic and `# comment`
 *     lines inside them are ignored). Lines are grouped into "sections" where
 *     each section carries its hierarchical `sectionPath` (e.g. `['A', 'B']`).
 *     Text appearing before any heading lives in a synthetic preamble section
 *     with `sectionPath = []`.
 *
 *  2. For each section, split its body into paragraphs on blank-line runs
 *     while keeping fenced code blocks as a single atomic paragraph (even if
 *     they contain blank lines).
 *
 *  3. Greedy-pack paragraphs into chunks bounded by `maxChars`. If a paragraph
 *     overflows the current chunk, emit the current chunk and start a new one
 *     seeded with overlap from the tail of the just-emitted chunk. Overlap is
 *     sentence-aware: take as many *trailing* sentences as fit in `overlap`
 *     chars, falling back to a raw char slice if no sentence boundary is
 *     available (avoids mid-word breaks where possible).
 *
 *  4. If a single paragraph by itself exceeds `maxChars`, split it on
 *     sentences and pack those. If a single sentence still exceeds `maxChars`
 *     (rare — minified or no-whitespace content), hard-window it.
 *
 *  5. Section boundaries are HARD — when moving to the next section, the
 *     previous chunk is emitted as-is and no overlap is carried across. This
 *     keeps `sectionPath` consistent per chunk.
 *
 *  6. Chunks shorter than `MIN_CHUNK` chars (after trim) are dropped, EXCEPT
 *     when this would yield zero chunks for a non-empty doc — in which case
 *     the single short chunk is returned. This keeps tiny docs indexable.
 */

export interface ChunkOptions {
  maxChars?: number
  overlap?: number
}

export interface Chunk {
  text: string
  sectionPath: string[]
}

const DEFAULT_MAX = 1500
const DEFAULT_OVERLAP = 150

/* -------------------------------------------------------------------------- */
/*  Pre-pass: split source into sections                                       */
/* -------------------------------------------------------------------------- */

interface RawSection {
  path: string[]
  body: string
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const FENCE_RE = /^(```|~~~)/

function splitIntoSections(md: string): RawSection[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const sections: RawSection[] = []
  // Heading stack: indexed by depth-1; slots may be undefined for skipped levels.
  let stack: (string | undefined)[] = []
  let currentPath: string[] = []
  let buffer: string[] = []
  let inFence = false

  const flush = () => {
    const body = buffer.join('\n').trim()
    // Drop sections that are completely empty (no heading and no body). For
    // a heading with empty body, we still keep it so the path is preserved
    // in case subsequent re-rendering needs it; but the packer will skip it.
    if (body.length > 0 || currentPath.length > 0) {
      sections.push({ path: [...currentPath], body })
    }
    buffer = []
  }

  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence
      buffer.push(line)
      continue
    }

    if (inFence) {
      buffer.push(line)
      continue
    }

    const m = line.match(HEADING_RE)
    if (m && m[1] && m[2]) {
      const depth = m[1].length
      const title = m[2].trim()
      flush()
      // Update stack to this depth.
      stack = stack.slice(0, depth - 1)
      while (stack.length < depth - 1) stack.push(undefined)
      stack.push(title)
      currentPath = stack.filter((s): s is string => typeof s === 'string')
      continue
    }

    buffer.push(line)
  }
  flush()

  return sections
}

/* -------------------------------------------------------------------------- */
/*  Paragraph splitter — fence-aware                                           */
/* -------------------------------------------------------------------------- */

/**
 * Split a section body into paragraphs on `\n{2,}`, but keep fenced code
 * blocks (` ``` ... ``` `) as a single atomic paragraph even if they contain
 * blank lines.
 */
function splitParagraphs(body: string): string[] {
  if (body.length === 0) return []
  const lines = body.split('\n')
  const paras: string[] = []
  let buf: string[] = []
  let inFence = false

  const flushBuf = () => {
    // Flush accumulated buf, splitting on blank-line runs.
    const joined = buf.join('\n')
    for (const p of joined.split(/\n{2,}/g)) {
      const trimmed = p.trim()
      if (trimmed.length > 0) paras.push(trimmed)
    }
    buf = []
  }

  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      if (!inFence) {
        // Opening fence: flush any prose accumulated so far, then start the
        // fence as its own buf.
        flushBuf()
        buf.push(line)
        inFence = true
      }
      else {
        // Closing fence: finalize the fenced block as one paragraph.
        buf.push(line)
        paras.push(buf.join('\n'))
        buf = []
        inFence = false
      }
      continue
    }
    buf.push(line)
  }

  if (inFence) {
    // Unclosed fence — treat the rest as one atomic paragraph.
    paras.push(buf.join('\n'))
  }
  else {
    flushBuf()
  }

  return paras
}

/* -------------------------------------------------------------------------- */
/*  Sentence splitter                                                          */
/* -------------------------------------------------------------------------- */

function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/g)
    .map(s => s.trim())
    .filter(s => s.length > 0)
  return parts.length > 0 ? parts : [text]
}

/**
 * Take the trailing slice of `text` that is at most `maxChars` long, preferring
 * to start on a sentence boundary. If no boundary fits, fall back to the raw
 * char tail.
 */
function trailingOverlap(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length === 0) return ''
  if (text.length <= maxChars) return text
  const sentences = splitSentences(text)
  if (sentences.length > 1) {
    // Greedily accumulate sentences from the end until adding another would
    // exceed maxChars.
    const acc: string[] = []
    let len = 0
    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i]!
      const add = (acc.length === 0 ? 0 : 1) + s.length // +1 for the joining space
      if (len + add > maxChars) break
      acc.unshift(s)
      len += add
    }
    if (acc.length > 0) return acc.join(' ')
  }
  return text.slice(-maxChars)
}

function hardWindow(text: string, maxChars: number, overlap: number): string[] {
  const stride = Math.max(1, maxChars - overlap)
  const out: string[] = []
  for (let i = 0; i < text.length; i += stride) {
    out.push(text.slice(i, i + maxChars))
    if (i + maxChars >= text.length) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Packer                                                                     */
/* -------------------------------------------------------------------------- */

interface Packer {
  push: (atom: string) => void
  flush: () => void
}

function makePacker(
  out: Chunk[],
  sectionPath: string[],
  maxChars: number,
  overlap: number,
): Packer {
  let current = ''

  const emit = (): string => {
    const emitted = current.trim()
    if (emitted.length > 0) {
      out.push({ text: emitted, sectionPath: [...sectionPath] })
    }
    return emitted
  }

  const push = (atom: string) => {
    if (atom.length === 0) return
    if (current.length === 0) {
      current = atom
      return
    }
    const candidate = `${current}\n\n${atom}`
    if (candidate.length <= maxChars) {
      current = candidate
      return
    }
    // Overflow: emit current, then seed next chunk with overlap from the
    // chunk we just emitted (sentence-aware).
    const justEmitted = emit()
    const seed = overlap > 0 ? trailingOverlap(justEmitted, overlap) : ''
    current = seed.length > 0 ? `${seed}\n\n${atom}` : atom
    // If even seed+atom exceeds maxChars (atom alone is already <= maxChars
    // since we hard-window earlier), drop the seed.
    if (current.length > maxChars) current = atom
  }

  const flush = () => {
    emit()
    current = ''
  }

  return { push, flush }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Chunk a markdown string into section-aware pieces. Each chunk carries the
 * heading-hierarchy path that produced it (empty array for preamble).
 */
export function chunkMarkdown(md: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX)
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP, Math.floor(maxChars / 2)))

  const source = (md ?? '').replace(/\r\n/g, '\n')
  if (source.trim().length === 0) return []

  const sections = splitIntoSections(source)
  const out: Chunk[] = []

  for (const section of sections) {
    if (section.body.length === 0) continue

    const packer = makePacker(out, section.path, maxChars, overlap)
    const paragraphs = splitParagraphs(section.body)

    for (const para of paragraphs) {
      if (para.length <= maxChars) {
        packer.push(para)
        continue
      }
      // Paragraph alone is too large — fall back to sentence packing within
      // this same section. Use a nested packer pattern: just push sentences
      // through the same packer (they're still part of this section).
      for (const sentence of splitSentences(para)) {
        if (sentence.length <= maxChars) {
          packer.push(sentence)
          continue
        }
        // Sentence itself overflows: hard-window.
        for (const win of hardWindow(sentence, maxChars, overlap)) {
          packer.push(win)
        }
      }
    }
    packer.flush()
  }

  return out
}
