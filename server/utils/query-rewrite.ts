/**
 * Conversation-aware query rewriting.
 *
 * Embedding a follow-up like "et le deuxième point ?" verbatim wastes the
 * embed call — the meaningful tokens live in the prior turns. Before the
 * retrieval step, we ask Mistral to rewrite the user's current message into
 * a standalone query that carries forward the relevant context. The chat
 * message sent to the model is untouched: only the *retrieval* query is
 * reformulated.
 *
 * Failure modes are silent on purpose: a failed rewrite returns the original
 * message so chat never blocks on this auxiliary call.
 */
import { mistralChat, type MistralMessage } from './mistral'
import { createCircuitBreaker } from './circuit-breaker'

/** Small model for cheap auxiliary calls (rewrite + rerank). */
export const FAST_MODEL = 'mistral-small-latest'

/**
 * Breaker for the rewriter. Same 3-failures-in-60s / 60s cooldown contract
 * as the reranker. When tripped, `rewriteQuery` returns the original message
 * verbatim so retrieval still runs.
 */
const rewriterBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 })

/** Read-only accessor so future admin panels can surface breaker state. */
export function getRewriterCircuitOpen(): boolean {
  return rewriterBreaker.isOpen()
}

const SYSTEM_PROMPT = `You rewrite the user's latest message into a SELF-CONTAINED retrieval query.

Rules:
- Resolve pronouns and anaphora using the conversation history.
- Preserve the user's language and key technical terms verbatim.
- Output ONLY the rewritten query, no preamble, no quotes, no explanation.
- If the latest message is already standalone, return it unchanged.
- If the latest message is purely conversational (greeting, thanks, meta-question
  about the assistant itself), return it unchanged — don't invent topics.
- Keep it short: a phrase or a single sentence, never a paragraph.

Respond as JSON: {"query": "<the rewritten query>"}`

interface RewriteResponse {
  query?: unknown
}

/**
 * Rewrite the current user message into a standalone query using the prior
 * conversation turns. Returns the original message when:
 *   - history is empty (first turn — nothing to resolve against),
 *   - the Mistral call fails (network, parse, schema),
 *   - the model produces an empty / suspiciously long output.
 */
export async function rewriteQuery(
  history: MistralMessage[],
  current: string,
  userId?: number,
): Promise<string> {
  const trimmed = current.trim()
  if (trimmed.length === 0) return current

  // No prior context → nothing to resolve. Skip the LLM round-trip entirely.
  const priorTurns = history.filter(m => m.role === 'user' || m.role === 'assistant')
  if (priorTurns.length === 0) return current

  // Breaker open → skip the LLM round-trip and return the original message.
  if (rewriterBreaker.isOpen()) return current

  // Build a compact history view. Cap each turn so the rewriter doesn't pay
  // for the full retrieved-context history. Multimodal user messages (Wave 4
  // / N7) carry an array of content parts — flatten to the text portion so
  // the rewriter only sees the prose that actually matters for retrieval.
  const transcript = priorTurns
    .slice(-6)
    .map((m) => {
      const flat = typeof m.content === 'string'
        ? m.content
        : m.content
          .filter((p): p is { type: 'text', text: string } => p.type === 'text')
          .map(p => p.text)
          .join(' ')
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(flat, 600)}`
    })
    .join('\n')

  const userPrompt =
    `Conversation so far:\n${transcript}\n\n`
    + `Latest user message:\n${trimmed}\n\n`
    + `Rewrite the latest message as a standalone retrieval query.`

  try {
    const { content } = await mistralChat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0,
      model: FAST_MODEL,
      userId,
      operation: 'rewrite',
    })
    const parsed = JSON.parse(content) as RewriteResponse
    const out = typeof parsed.query === 'string' ? parsed.query.trim() : ''
    if (out.length === 0) {
      rewriterBreaker.recordSuccess()
      return current
    }
    // Sanity bound: never grow the query beyond ~6x the original — if the
    // model decided to elaborate, that's drift, not rewriting.
    if (out.length > Math.max(400, trimmed.length * 6)) {
      rewriterBreaker.recordSuccess()
      return current
    }
    rewriterBreaker.recordSuccess()
    return out
  }
  catch {
    rewriterBreaker.recordFailure()
    return current
  }
}

function truncate(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= n) return cleaned
  return `${cleaned.slice(0, n - 1).trimEnd()}…`
}
