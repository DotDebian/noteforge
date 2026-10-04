/**
 * Conversation-aware query rewriting.
 *
 * Embedding a follow-up like "et le deuxième point ?" verbatim wastes the
 * embed call — the meaningful tokens live in the prior turns. Before the
 * retrieval step, we ask Claude to rewrite the user's current message into
 * a standalone query that carries forward the relevant context. The chat
 * message sent to the model is untouched: only the *retrieval* query is
 * reformulated.
 *
 * Failure modes are silent on purpose: a failed rewrite returns the original
 * message so chat never blocks on this auxiliary call.
 */
import { claudeChat, type ChatMessage } from './claude'
import { createCircuitBreaker } from './circuit-breaker'

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

const SYSTEM_PROMPT = `You rewrite the user's latest message into a self-contained retrieval query for a search over their personal notes. The query is embedded and keyword-matched, so it has to carry its own context: the search engine never sees the conversation.

- Resolve pronouns and references ("it", "the second point", "et celui-là ?") using the conversation history.
- Keep the user's language and their key technical terms verbatim.
- If the latest message is already standalone, or purely conversational (a greeting, thanks, a question about the assistant itself), return it unchanged rather than inventing a topic.
- Keep it short: a phrase or a single sentence.

Your reply is used verbatim as the search query, so output only the query text: no preamble, no quotes, no explanation.`

/**
 * Rewrite the current user message into a standalone query using the prior
 * conversation turns. Returns the original message when:
 *   - history is empty (first turn — nothing to resolve against),
 *   - the Claude call fails,
 *   - the model produces an empty / suspiciously long output.
 */
export async function rewriteQuery(
  history: ChatMessage[],
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
    const { content } = await claudeChat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      userId,
      operation: 'rewrite',
    })
    // Tolerate a stray pair of wrapping quotes around the query.
    const out = content.trim().replace(/^["'«“]\s*|\s*["'»”]$/g, '').trim()
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
