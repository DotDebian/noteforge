/**
 * Lightweight YAML frontmatter parser. Not a full YAML implementation —
 * we only honor `title` (string) and `tags` (YAML inline list or comma list).
 *
 * Frontmatter block must start at the very first byte of the file with
 * `---\n` and close with `\n---\n` (or `\n---` at end of file). Anything
 * else is treated as plain markdown.
 */
export interface ParsedFrontmatter {
  title?: string
  tags?: string[]
  body: string
}

const OPEN_RE = /^---\r?\n/
const CLOSE_RE = /\r?\n---(?:\r?\n|$)/

export function parseFrontmatter(md: string): ParsedFrontmatter {
  if (!OPEN_RE.test(md)) return { body: md }

  // Strip opening fence to locate close.
  const afterOpen = md.replace(OPEN_RE, '')
  const closeMatch = CLOSE_RE.exec(afterOpen)
  if (!closeMatch || closeMatch.index === undefined) {
    return { body: md }
  }

  const block = afterOpen.slice(0, closeMatch.index)
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length)

  let title: string | undefined
  let tags: string[] | undefined

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const titleMatch = /^title\s*:\s*(.+)$/i.exec(line)
    if (titleMatch && titleMatch[1] !== undefined) {
      title = stripQuotes(titleMatch[1].trim())
      continue
    }

    const tagsMatch = /^tags\s*:\s*(.+)$/i.exec(line)
    if (tagsMatch && tagsMatch[1] !== undefined) {
      tags = parseTagsValue(tagsMatch[1].trim())
      continue
    }
  }

  return { title, tags, body }
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return s.slice(1, -1)
    }
  }
  return s
}

function parseTagsValue(s: string): string[] {
  const trimmed = s.trim()
  // YAML inline list: [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(t => stripQuotes(t.trim()))
      .filter(t => t.length > 0)
  }
  // Comma list: a, b, c
  return trimmed
    .split(',')
    .map(t => stripQuotes(t.trim()))
    .filter(t => t.length > 0)
}
