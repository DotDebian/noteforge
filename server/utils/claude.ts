/**
 * Text generation through the Claude Agent SDK.
 *
 * The SDK drives a Claude Code subprocess; we run it as a plain completion
 * engine: no built-in tools, no MCP servers, no filesystem settings, no
 * session persistence, our own system prompt. Credentials come from the process environment —
 * `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`
 * — which the subprocess inherits.
 *
 * Three things differ from a chat-completions API and shape this wrapper:
 *  - One prompt per query. Prior turns are folded into the prompt as a
 *    `<conversation_history>` block instead of being replayed as messages.
 *  - No sampling knobs. Depth is steered with `effort`, not temperature.
 *  - JSON comes from `outputFormat` (schema-validated, costs an extra turn),
 *    so callers on the latency-critical path ask for plain text instead.
 */
import { tmpdir } from 'node:os'
import { createError } from 'h3'
import { query, type EffortLevel, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { recordProviderSuccess } from './provider-health'
import { logAiUsage } from './ai-usage'

// `useRuntimeConfig` is an auto-imported Nitro helper in server contexts.

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5'
export const DEFAULT_CLAUDE_EFFORT: EffortLevel = 'medium'

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ChatRole = 'system' | 'user' | 'assistant'

/** Image formats the Claude API accepts as base64 input. */
export const CLAUDE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export type ClaudeImageMime = typeof CLAUDE_IMAGE_MIMES[number]

export type ChatContentPart =
  | { type: 'text', text: string }
  | { type: 'image', mediaType: ClaudeImageMime, data: string }

export interface ChatMessage {
  role: ChatRole
  /**
   * Most messages are plain strings. A user message with an attached image
   * uses the array form (text + base64 image).
   */
  content: string | ChatContentPart[]
}

export interface ClaudeChatOptions {
  messages: ChatMessage[]
  /**
   * JSON Schema the reply must satisfy. The validated object comes back as
   * `structured` (and serialized in `content`).
   */
  jsonSchema?: Record<string, unknown>
  model?: string
  effort?: EffortLevel
  userId?: number
  operation?: string
}

export function getClaudeModel(override?: string): string {
  if (override) return override
  const cfg = useRuntimeConfig()
  return (cfg.claudeModel as string) || DEFAULT_CLAUDE_MODEL
}

function getEffort(override?: EffortLevel): EffortLevel {
  if (override) return override
  const configured = useRuntimeConfig().claudeEffort as string
  return EFFORT_LEVELS.find(e => e === configured) ?? DEFAULT_CLAUDE_EFFORT
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text', text: string } => p.type === 'text')
    .map(p => p.text)
    .join('\n')
}

const HISTORY_NOTE = 'Earlier turns of this conversation are provided inside <conversation_history>. Reply only to the message inside <current_message>.'

/**
 * Collapse a chat-style message list into the SDK's shape: one system prompt
 * and one user prompt. The last message must be the user turn to answer.
 */
function toPrompt(messages: ChatMessage[]): { system: string, prompt: string | AsyncIterable<SDKUserMessage> } {
  const systemParts = messages.filter(m => m.role === 'system').map(m => textOf(m.content))
  const turns = messages.filter(m => m.role !== 'system')
  const current = turns[turns.length - 1]
  if (!current || current.role !== 'user') {
    throw createError({
      statusCode: 500,
      statusMessage: 'claude_failed',
      data: { error: 'claude_failed', detail: 'Last message must be a user message' },
    })
  }
  const history = turns.slice(0, -1)

  let text = textOf(current.content)
  if (history.length > 0) {
    systemParts.push(HISTORY_NOTE)
    const transcript = history
      .map(m => `<${m.role}>\n${textOf(m.content)}\n</${m.role}>`)
      .join('\n')
    text = `<conversation_history>\n${transcript}\n</conversation_history>\n\n<current_message>\n${text}\n</current_message>`
  }
  const system = systemParts.join('\n\n')

  const images = typeof current.content === 'string'
    ? []
    : current.content.filter((p): p is Extract<ChatContentPart, { type: 'image' }> => p.type === 'image')
  if (images.length === 0) return { system, prompt: text }

  // Images only travel through the streaming-input form of `prompt`.
  async function* single(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          ...images.map(img => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
          })),
          { type: 'text' as const, text },
        ],
      },
    }
  }
  return { system, prompt: single() }
}

type RunEvent =
  | { kind: 'text', text: string }
  | { kind: 'final', content: string, structured?: unknown }

function fail(detail: string): never {
  throw createError({
    statusCode: 502,
    statusMessage: 'claude_failed',
    data: { error: 'claude_failed', detail },
  })
}

async function* run(opts: ClaudeChatOptions, stream: boolean): AsyncGenerator<RunEvent, void, unknown> {
  const model = getClaudeModel(opts.model)
  const operation = opts.operation ?? (stream ? 'chat_stream' : 'chat')
  const { system, prompt } = toPrompt(opts.messages)
  const executable = process.env.CLAUDE_CODE_EXECUTABLE

  const options: Options = {
    model,
    effort: getEffort(opts.effort),
    systemPrompt: system,
    // Completion engine only: no built-in tools, no CLAUDE.md / settings from
    // disk, nothing written to ~/.claude/projects.
    tools: [],
    settingSources: [],
    persistSession: false,
    // ⚠️ MCP isolation. A Claude login also carries the account's claude.ai
    // connectors (Notion, Drive, …): left alone, the subprocess loads them,
    // which adds ~100K tokens of tool definitions to every call and lets the
    // model reach for them. Either switch below is enough; both are set.
    strictMcpConfig: true,
    mcpServers: {},
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    cwd: tmpdir(),
    // Structured output is delivered through an internal tool call, so it
    // needs more than one turn.
    maxTurns: opts.jsonSchema ? 4 : 1,
    includePartialMessages: stream,
    ...(opts.jsonSchema ? { outputFormat: { type: 'json_schema' as const, schema: opts.jsonSchema } } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
  }

  const start = Date.now()
  const logFailure = (code: string): void =>
    logAiUsage(opts.userId, model, operation, 0, 0, 0, false, Date.now() - start, code)

  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'stream_event') {
        if (msg.parent_tool_use_id !== null) continue
        const ev = msg.event
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text.length > 0) {
          yield { kind: 'text', text: ev.delta.text }
        }
        continue
      }
      if (msg.type !== 'result') continue

      if (msg.subtype !== 'success') {
        logFailure(msg.subtype)
        fail(msg.errors.join('; ') || msg.subtype)
      }
      if (msg.is_error) {
        // e.g. an auth failure: the CLI reports it as the "result" text.
        logFailure(msg.api_error_status != null ? `http_${msg.api_error_status}` : 'api_error')
        fail(msg.result || 'Claude returned an error')
      }

      const structured = msg.structured_output
      const content = opts.jsonSchema ? JSON.stringify(structured ?? null) : msg.result
      if (opts.jsonSchema ? structured == null : content.length === 0) {
        logFailure(msg.stop_reason === 'refusal' ? 'refusal' : 'empty_response')
        fail(msg.stop_reason === 'refusal' ? 'Claude declined to answer' : 'Empty Claude response')
      }

      try { recordProviderSuccess('claude') } catch { /* health tracking must never throw */ }
      const u = msg.usage
      const promptTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      logAiUsage(opts.userId, model, operation,
        promptTokens, u.output_tokens, promptTokens + u.output_tokens, true, Date.now() - start)
      yield { kind: 'final', content, ...(opts.jsonSchema ? { structured } : {}) }
      return
    }
  }
  catch (err) {
    // Our own `fail()` errors already logged + shaped — pass them through.
    if ((err as { statusMessage?: string }).statusMessage === 'claude_failed') throw err
    logFailure('process')
    fail((err as Error).message ?? 'Claude process failed')
  }

  logFailure('no_result')
  fail('Claude ended without a result')
}

/** One-shot generation. With `jsonSchema`, `structured` holds the validated object. */
export async function claudeChat(opts: ClaudeChatOptions): Promise<{ content: string, structured?: unknown }> {
  for await (const ev of run(opts, false)) {
    if (ev.kind === 'final') return { content: ev.content, structured: ev.structured }
  }
  return fail('Claude ended without a result')
}

/**
 * Async generator yielding the answer's text deltas as they arrive.
 * Throws a 502 createError if the call fails.
 */
export async function* claudeChatStream(
  opts: Omit<ClaudeChatOptions, 'jsonSchema'>,
): AsyncGenerator<string, void, unknown> {
  for await (const ev of run(opts, true)) {
    if (ev.kind === 'text') yield ev.text
  }
}
