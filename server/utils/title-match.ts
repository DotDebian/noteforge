/**
 * Fuzzy title matching for the MCP `find_document` tool (and any future
 * "resolve by name" feature). Encrypted titles can't be filtered in SQL
 * (fresh IV → different ciphertext), so resolution is always
 * fetch + decrypt + JS-score — these helpers are the scoring half.
 *
 * Pure functions, no DB access — unit-tested in tests/title-match.test.ts.
 */

/**
 * Normalise a title or query for comparison: NFD-fold accents away
 * (é → e), lowercase, collapse every non-alphanumeric run to a single
 * space. "Réunion d'équipe — Q3" and "reunion equipe q3" normalise the
 * same way.
 */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Score how well `title` matches `query`, in [0, 1]. Tiers:
 *   1.0   exact (normalised) match
 *   0.9   title starts with the query
 *   0.75  query appears as a substring
 *   0.7   every query token appears as a title token (any order)
 *   <0.7  partial token overlap, proportional (0.3 + 0.4 × matched/total)
 *   0     no token in common
 *
 * The tiers are ordinal, not calibrated probabilities — callers sort by
 * score and apply a floor (see TITLE_MATCH_MIN_SCORE).
 */
export function scoreTitleMatch(query: string, title: string): number {
  const q = normalizeTitle(query)
  const t = normalizeTitle(title)
  if (q.length === 0 || t.length === 0) return 0

  if (t === q) return 1
  if (t.startsWith(q)) return 0.9
  if (t.includes(q)) return 0.75

  const qTokens = q.split(' ')
  const tTokens = new Set(t.split(' '))
  let matched = 0
  for (const tok of qTokens) {
    if (tTokens.has(tok)) matched++
  }
  if (matched === 0) return 0
  if (matched === qTokens.length) return 0.7
  return 0.3 + 0.4 * (matched / qTokens.length)
}

/** Default relevance floor for `scoreTitleMatch` results. */
export const TITLE_MATCH_MIN_SCORE = 0.3
