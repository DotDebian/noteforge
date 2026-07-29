/**
 * Unified-diff (git-like) patcher for document markdown.
 *
 * Why: `update_document` forces an LLM to re-emit the WHOLE body to change
 * three lines in the middle of a long note — slow and token-expensive.
 * `append_to_document` only covers the tail. This module applies a standard
 * `@@ … @@` unified diff to a markdown string so a client can rewrite a
 * section in place.
 *
 * Deliberate deviations from GNU `patch`, tuned for LLM-authored diffs:
 *   - **Line numbers are advisory.** Hunks are located by matching their
 *     context + removed lines against the document; the `@@ -a,b +c,d @@`
 *     numbers only bias WHICH occurrence is picked when several match. A
 *     model that miscounts lines still lands the patch.
 *   - **Whitespace fallback.** If no exact match exists, a second pass
 *     compares `line.trim()` (reported back as `whitespace` matching).
 *   - **Fuzz.** Common leading/trailing lines shared by the before/after
 *     sides (i.e. pure context) are trimmed up to `MAX_FUZZ` per side when
 *     the full hunk doesn't match — same idea as `patch --fuzz`.
 *   - **Lenient parsing.** Fenced blocks, `diff --git` / `---` / `+++`
 *     preambles and unprefixed context lines are tolerated; every leniency
 *     is reported in `warnings` so the caller can nudge the model.
 *
 * Pure module on purpose (no `h3`, no db) so `tests/patch.test.ts` can import
 * it — same split rationale as `oauth-policy.ts` vs `oauth.ts`.
 */

/** Max context lines trimmed from each end of a hunk before giving up. */
const MAX_FUZZ = 3
/** Lines of real document shown around a failed hunk, for the retry hint. */
const ERROR_CONTEXT_LINES = 12
/** Per-line cap in error payloads — these travel back into an LLM context. */
const ERROR_LINE_MAX_CHARS = 200

export type HunkLineKind = 'context' | 'remove' | 'add'

export interface ParsedHunk {
  /** 1-based index in the patch, for error messages. */
  index: number
  /** Raw `@@ … @@` line, minus the trailing section heading. */
  header: string
  /** `-a` from the header (1-based), or `null` when the header omits it. */
  oldStart: number | null
  /** Context + removed lines: what must be found in the document. */
  before: string[]
  /** Context + added lines: what replaces it. */
  after: string[]
  /** Count of `-` lines. */
  removed: number
  /** Count of `+` lines. */
  added: number
}

export type HunkMatchKind = 'exact' | 'whitespace' | 'insertion'

export interface AppliedHunk {
  index: number
  header: string
  /** 1-based line in the ORIGINAL document where the hunk landed. */
  appliedAtLine: number
  /** Signed distance between the declared and the actual position. */
  lineDrift: number
  match: HunkMatchKind
  /** Context lines trimmed from each end to make it fit (0 = clean). */
  fuzz: number
  removed: number
  added: number
}

export interface PatchFailure {
  index: number
  header: string
  reason: string
  /** The block we searched for (context + removed lines). */
  expected: string[]
  /** What the document actually holds around the declared position. */
  actual: { fromLine: number, lines: string[] }
}

export type ApplyPatchResult =
  | { ok: true, markdown: string, hunks: AppliedHunk[], warnings: string[] }
  | { ok: false, failure: PatchFailure, warnings: string[] }

export class PatchParseError extends Error {}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** `@@ -12,7 +12,9 @@ optional heading` — every numeric part optional. */
const HUNK_HEADER_RE = /^@@\s*(?:-(\d+)(?:,(\d+))?)?\s*(?:\+(\d+)(?:,(\d+))?)?\s*@*\s*(.*)$/
/** Lines that introduce a file, only meaningful OUTSIDE a hunk body. */
const FILE_HEADER_RE = /^(?:diff --git |index [0-9a-f]{4,}|--- |\+\+\+ |Index: |={5,}$|\*\*\* )/

/**
 * Parse a unified diff into hunks. Throws `PatchParseError` with an
 * actionable message when there is nothing applicable in it.
 */
export function parseUnifiedPatch(patch: string): { hunks: ParsedHunk[], warnings: string[] } {
  const warnings: string[] = []
  const lines = stripCodeFence(patch.replace(/\r\n?/g, '\n')).split('\n')

  // The patch's own trailing newline(s) would otherwise be read as blank
  // context lines and appended to the last hunk — a phantom line that breaks
  // matching at end-of-document. A genuinely blank context line is emitted as
  // a single space by every diff tool, so trimming empty tail lines is safe.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (line.startsWith('@@')) {
      const m = HUNK_HEADER_RE.exec(line)
      if (m) {
        current = {
          index: hunks.length + 1,
          header: line.trim(),
          oldStart: m[1] != null ? Number(m[1]) : null,
          before: [],
          after: [],
          removed: 0,
          added: 0,
        }
        hunks.push(current)
        continue
      }
    }

    if (!current) {
      // Preamble (`diff --git`, `---`, `+++`, prose the model wrapped it in).
      continue
    }

    if (line.startsWith('\\')) continue // "\ No newline at end of file"

    const marker = line.charAt(0)
    const body = line.slice(1)

    if (line.length === 0) {
      // A blank context line whose single leading space was trimmed — by the
      // model, or by anything that touched the payload en route.
      current.before.push('')
      current.after.push('')
    }
    else if (marker === ' ') {
      current.before.push(body)
      current.after.push(body)
    }
    else if (marker === '-') {
      current.before.push(body)
      current.removed++
    }
    else if (marker === '+') {
      current.after.push(body)
      current.added++
    }
    else if (FILE_HEADER_RE.test(line)) {
      // A new file section inside a multi-file patch: nothing to bind it to
      // (we patch exactly one document), so close the current hunk.
      current = null
    }
    else {
      // Unprefixed line inside a hunk. Almost always a context line the model
      // forgot to indent — treat it as such, but say so.
      current.before.push(line)
      current.after.push(line)
      warnings.push(`hunk ${current.index}: line ${i + 1} has no +/-/space prefix, treated as context`)
    }
  }

  if (hunks.length === 0) {
    throw new PatchParseError(
      'No hunk found. Expected a unified diff: one or more `@@ … @@` headers, then lines '
      + 'prefixed with a space (context), `-` (remove) or `+` (add).',
    )
  }

  const empty = hunks.filter(h => h.before.length === 0 && h.after.length === 0)
  if (empty.length === hunks.length) {
    throw new PatchParseError('Every hunk is empty — no context, no `-` and no `+` lines.')
  }

  const noop = hunks.filter(h => sameLines(h.before, h.after))
  if (noop.length === hunks.length) {
    throw new PatchParseError('The patch changes nothing: no `-` or `+` line in any hunk.')
  }

  return { hunks: hunks.filter(h => !sameLines(h.before, h.after)), warnings }
}

/** Drop a ```/```diff wrapper the model may have added around the patch. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return text
  const lines = trimmed.split('\n')
  const last = lines[lines.length - 1]?.trim()
  if (last !== '```') return text
  return lines.slice(1, -1).join('\n')
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/* -------------------------------------------------------------------------- */
/*  Applying                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Apply a unified diff to `source`. All-or-nothing: the first hunk that
 * cannot be located aborts the whole patch, so a document is never left
 * half-modified.
 */
export function applyUnifiedPatch(source: string, patch: string): ApplyPatchResult {
  const { hunks, warnings } = parseUnifiedPatch(patch)
  const lines = source.replace(/\r\n?/g, '\n').split('\n')

  const applied: AppliedHunk[] = []
  // Hunks are applied in document order; `cursor` forbids a later hunk from
  // matching before an earlier one (and from re-matching lines it just wrote).
  let cursor = 0
  let drift = 0

  for (const hunk of hunks) {
    const declared = hunk.oldStart != null ? hunk.oldStart - 1 : null
    const preferred = clamp(declared != null ? declared + drift : cursor, 0, lines.length)

    if (hunk.before.length === 0) {
      // Pure insertion with zero context — only the declared position can
      // place it.
      if (declared == null) {
        return {
          ok: false,
          warnings,
          failure: {
            index: hunk.index,
            header: hunk.header,
            reason:
              'Insertion-only hunk with no context lines and no line number in the `@@` header. '
              + 'Add at least one surrounding context line (prefixed with a space) so the position '
              + 'can be resolved.',
            expected: [],
            actual: documentWindow(lines, preferred),
          },
        }
      }
      const at = clamp(preferred, cursor, lines.length)
      lines.splice(at, 0, ...hunk.after)
      applied.push({
        index: hunk.index,
        header: hunk.header,
        appliedAtLine: at + 1,
        lineDrift: at - (declared + drift),
        match: 'insertion',
        fuzz: 0,
        removed: 0,
        added: hunk.after.length,
      })
      cursor = at + hunk.after.length
      drift += hunk.after.length
      continue
    }

    const located = locateHunk(lines, hunk, preferred, cursor)
    if (!located) {
      return {
        ok: false,
        warnings,
        failure: {
          index: hunk.index,
          header: hunk.header,
          reason: describeMiss(lines, hunk, cursor),
          expected: hunk.before.map(truncateLine),
          actual: documentWindow(lines, preferred),
        },
      }
    }

    lines.splice(located.index, located.before.length, ...located.after)
    applied.push({
      index: hunk.index,
      header: hunk.header,
      appliedAtLine: located.index - located.fuzzTop + 1,
      lineDrift: located.index - located.fuzzTop - preferred,
      match: located.match,
      fuzz: located.fuzzTop + located.fuzzBottom,
      removed: hunk.removed,
      added: hunk.added,
    })
    cursor = located.index + located.after.length
    drift += located.after.length - located.before.length
  }

  return { ok: true, markdown: lines.join('\n'), hunks: applied, warnings }
}

interface LocatedHunk {
  index: number
  before: string[]
  after: string[]
  match: Exclude<HunkMatchKind, 'insertion'>
  fuzzTop: number
  fuzzBottom: number
}

/**
 * Find where a hunk applies: exact match first, then whitespace-insensitive,
 * then the same two passes again after trimming shared context off each end
 * (fuzz). Within a pass, the occurrence closest to `preferred` wins.
 */
function locateHunk(
  lines: string[],
  hunk: ParsedHunk,
  preferred: number,
  minStart: number,
): LocatedHunk | null {
  let before = hunk.before
  let after = hunk.after
  let fuzzTop = 0
  let fuzzBottom = 0

  for (;;) {
    for (const match of ['exact', 'whitespace'] as const) {
      const found = findBlock(lines, before, preferred - fuzzTop, minStart, match === 'whitespace')
      if (found != null) {
        return { index: found, before, after, match, fuzzTop, fuzzBottom }
      }
    }

    // Trim one shared line off whichever end still has one — bottom first,
    // matching how `patch` widens its search.
    const trimmed = trimSharedEdge(before, after, fuzzTop, fuzzBottom)
    if (!trimmed) return null
    before = trimmed.before
    after = trimmed.after
    fuzzTop = trimmed.fuzzTop
    fuzzBottom = trimmed.fuzzBottom
  }
}

function trimSharedEdge(
  before: string[],
  after: string[],
  fuzzTop: number,
  fuzzBottom: number,
): { before: string[], after: string[], fuzzTop: number, fuzzBottom: number } | null {
  const lastBefore = before[before.length - 1]
  const lastAfter = after[after.length - 1]
  if (
    fuzzBottom < MAX_FUZZ
    && before.length > 1
    && after.length > 0
    && lastBefore !== undefined
    && lastBefore === lastAfter
  ) {
    return {
      before: before.slice(0, -1),
      after: after.slice(0, -1),
      fuzzTop,
      fuzzBottom: fuzzBottom + 1,
    }
  }
  if (
    fuzzTop < MAX_FUZZ
    && before.length > 1
    && after.length > 0
    && before[0] !== undefined
    && before[0] === after[0]
  ) {
    return {
      before: before.slice(1),
      after: after.slice(1),
      fuzzTop: fuzzTop + 1,
      fuzzBottom,
    }
  }
  return null
}

/** Index of the occurrence of `block` closest to `preferred`, or null. */
function findBlock(
  lines: string[],
  block: string[],
  preferred: number,
  minStart: number,
  loose: boolean,
): number | null {
  let best: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = Math.max(0, minStart); i + block.length <= lines.length; i++) {
    if (!blockMatchesAt(lines, block, i, loose)) continue
    const distance = Math.abs(i - preferred)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

function blockMatchesAt(lines: string[], block: string[], at: number, loose: boolean): boolean {
  for (let j = 0; j < block.length; j++) {
    const expected = block[j] ?? ''
    const actual = lines[at + j] ?? ''
    if (loose ? expected.trim() !== actual.trim() : expected !== actual) return false
  }
  return true
}

/** Diagnose why a hunk missed, in words the calling model can act on. */
function describeMiss(lines: string[], hunk: ParsedHunk, minStart: number): string {
  if (hunk.after.length > 0 && findBlock(lines, hunk.after, minStart, minStart, false) != null) {
    return (
      'Hunk did not apply: the ORIGINAL lines were not found, but the PATCHED lines already are — '
      + 'this hunk looks already applied. Re-read the document before patching again.'
    )
  }
  const anchor = hunk.before.find(line => line.trim().length > 0)
  if (anchor && findBlock(lines, [anchor], minStart, minStart, true) == null) {
    return (
      `Hunk did not apply: no line matching \`${truncateLine(anchor)}\` exists in the document `
      + '(after the previous hunk). The context lines must be copied verbatim from the current '
      + 'document text.'
    )
  }
  return (
    'Hunk did not apply: the context/removed block was not found as a contiguous run, even ignoring '
    + 'indentation. Copy the lines verbatim from the current document, keep them contiguous, and '
    + 'remember hunks must be ordered top-to-bottom.'
  )
}

/** A readable slice of the real document around `at`, for error payloads. */
function documentWindow(lines: string[], at: number): { fromLine: number, lines: string[] } {
  const half = Math.floor(ERROR_CONTEXT_LINES / 2)
  const from = clamp(at - half, 0, Math.max(0, lines.length - 1))
  return {
    fromLine: from + 1,
    lines: lines.slice(from, from + ERROR_CONTEXT_LINES).map(truncateLine),
  }
}

function truncateLine(line: string): string {
  return line.length > ERROR_LINE_MAX_CHARS ? `${line.slice(0, ERROR_LINE_MAX_CHARS)}…` : line
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
