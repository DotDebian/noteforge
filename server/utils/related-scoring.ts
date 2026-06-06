/**
 * Related-notes scoring constants + helpers, shared between the live endpoint
 * (`ai/related/[docId].get.ts`) and the diagnostics dump
 * (`ai/debug/related.get.ts`) so the simulation can never drift from prod.
 */

/** Max hits returned by the related panel. */
export const TOP_K = 5

/** Weight applied to tag-overlap (Jaccard) on top of cosine similarity. */
export const TAG_WEIGHT = 0.15

/** Flat bonus for candidates explicitly linked to/from the query doc. */
export const LINK_BONUS = 0.1

/**
 * Relevance floor on the RAW cosine (before tag/link bonuses). `mistral-embed`
 * is anisotropic: two unrelated French summaries already land at ~0.73-0.76
 * cosine, so without a floor the panel fills its TOP_K with noise (the
 * welcome doc showed up everywhere at "75%").
 *
 * Calibrated 2026-06 on real data via the settings diagnostics dump:
 *   - unrelated pairs (welcome doc vs work notes): 0.733-0.762
 *   - genuinely related pairs: 0.777-0.901
 * 0.77 excludes every observed unrelated pair while keeping the tightest
 * real one (Timify architecture <-> Free Appointment spec at 0.7771).
 */
export const MIN_COSINE = 0.77

/**
 * Display renormalisation window for the UI: cosines compress into
 * [~0.65, ~0.95] in practice, so the panel maps that span onto 0-100%
 * instead of showing the raw cosine (which made "unrelated" read as 75%).
 * Keep in sync with `formatScore` in `DocumentInsightsPanel.vue`.
 */
export const DISPLAY_FLOOR = 0.65
export const DISPLAY_CEIL = 0.95

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
