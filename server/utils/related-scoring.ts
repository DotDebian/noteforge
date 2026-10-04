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
 * Relevance floor on the RAW cosine (before tag/link bonuses). Without one the
 * panel fills its TOP_K with noise whenever a workspace has few real
 * neighbours.
 *
 * Recalibrated 2026-10 for `voyage-4-large`, whose cosines spread far wider
 * than `mistral-embed`'s (which packed everything into ~0.73-0.99, hence the
 * old 0.77). Measured on the real corpus after re-embedding, doc-to-doc
 * max-of-chunks cosine: p5 0.45, median 0.63, p95 0.82. Pairs the old floor
 * rejected sit at a 0.55 median, pairs it kept at 0.63. 0.5 drops the same
 * bottom ~10% the old floor did.
 *
 * ⚠️ Calibrated on chunk vectors: summary vectors can't be rebuilt offline
 * (their source text is encrypted) and refill as notes are re-analysed.
 * Revisit with the settings diagnostics dump once they have.
 */
export const MIN_COSINE = 0.5

/**
 * Display renormalisation window for the UI: the panel maps this span onto
 * 0-100% instead of showing the raw cosine, so the floor reads as "weak"
 * rather than "50%". Keep in sync with `formatScore` in
 * `DocumentInsightsPanel.vue`.
 */
export const DISPLAY_FLOOR = 0.3
export const DISPLAY_CEIL = 0.9

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
