/**
 * Derive a chat session title from the first user message.
 *
 * Algorithm:
 *  - Trim surrounding whitespace.
 *  - Strip leading and trailing punctuation/whitespace.
 *  - Split on whitespace; keep the first 8 words.
 *  - Trim trailing punctuation from the last kept word.
 *  - Capitalize the first character (preserving the rest, so acronyms keep
 *    their original casing).
 *  - If the original message had more than 8 words, append a single-char
 *    ellipsis.
 *  - Fall back to 'New chat' if the result is empty.
 */
export function deriveSessionTitle(msg: string): string {
  const FALLBACK = 'New chat'
  const MAX_WORDS = 8

  const stripped = msg
    .trim()
    .replace(/^[\s\p{P}]+/u, '')
    .replace(/[\s\p{P}]+$/u, '')

  if (stripped.length === 0) return FALLBACK

  const words = stripped.split(/\s+/u).filter(w => w.length > 0)
  if (words.length === 0) return FALLBACK

  const kept = words.slice(0, MAX_WORDS)
  const lastIdx = kept.length - 1
  const last = kept[lastIdx]
  if (last !== undefined) {
    kept[lastIdx] = last.replace(/[\p{P}]+$/u, '')
  }

  // Drop any words that became empty after stripping.
  const cleaned = kept.filter(w => w.length > 0)
  if (cleaned.length === 0) return FALLBACK

  let joined = cleaned.join(' ')
  const firstChar = joined.charAt(0)
  if (firstChar.length > 0) {
    joined = firstChar.toLocaleUpperCase() + joined.slice(1)
  }

  if (words.length > MAX_WORDS) {
    joined = `${joined}…`
  }

  return joined.length > 0 ? joined : FALLBACK
}
