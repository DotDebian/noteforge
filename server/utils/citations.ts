/**
 * Extract citation numbers from the assistant text. Handles every form the
 * model tends to produce:
 *   [#1]              single citation
 *   [#1, #2]          comma-separated, each prefixed
 *   [#1,2,3]          comma-separated, prefix only once
 *   [#1; #5]          semicolon-separated
 *   [#1 #2]           space-separated
 *
 * We accept any `[#…]` block whose payload is only digits, hashes, commas,
 * semicolons and whitespace — then pull every digit run as a citation index.
 */
export function extractCitations(text: string): Set<number> {
  const set = new Set<number>()
  for (const block of text.matchAll(/\[#[\d#,;\s]+\]/g)) {
    for (const num of block[0].matchAll(/(\d+)/g)) {
      const n = Number(num[1])
      if (Number.isFinite(n) && n >= 1) set.add(n)
    }
  }
  return set
}
