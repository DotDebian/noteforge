/**
 * Sentence-level highlight: find the sentence inside `chunk` with the highest
 * token-overlap against `answer`. This lets the client surface the specific
 * fact the AI used instead of the chunk's first sentence (which is often
 * unrelated boilerplate, since chunks span ~1200 chars).
 */

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    // Letters / digits / whitespace; drop everything else.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3)
}

export function bestSentence(chunkText: string, answerText: string): string {
  // Strip the leading list/heading markers the chunker may have captured —
  // we want a "natural" sentence to surface.
  const cleaned = chunkText.replace(/\s+/g, ' ').trim()
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 20)
  if (sentences.length === 0) return cleaned.slice(0, 320)

  const answerTokens = new Set(tokenize(answerText))
  if (answerTokens.size === 0) return sentences[0] ?? cleaned.slice(0, 320)

  let bestIdx = 0
  let bestScore = -1
  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i]
    if (!sent) continue
    const tokens = tokenize(sent)
    if (tokens.length === 0) continue
    let overlap = 0
    for (const t of tokens) {
      if (answerTokens.has(t)) overlap++
    }
    // Normalise by sqrt(length) so longer sentences don't auto-win.
    const score = overlap / Math.sqrt(tokens.length)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return sentences[bestIdx] ?? sentences[0] ?? cleaned.slice(0, 320)
}
