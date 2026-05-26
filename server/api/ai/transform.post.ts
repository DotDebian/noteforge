/**
 * POST /api/ai/transform — selection-scoped LLM action.
 *
 * Streams the transformed text back as SSE so the editor can replace the
 * user's selection live (similar UX to ChatGPT inline rewrite). Each action
 * has its own crafted system prompt; the user text is dropped in as the
 * user message so we keep the Mistral chat shape unchanged.
 *
 * Frames:
 *   data: {"type":"delta","text":"…"}
 *   data: {"type":"done"}
 *   data: {"type":"error","detail":"…"}
 */
import { z } from 'zod'
import { mistralChatStream, type MistralMessage } from '~/server/utils/mistral'
import { requireUser } from '~/server/utils/require-user'

const ACTIONS = [
  'improve',
  'summarize',
  'translate',
  'continue',
  'explain',
  'tone',
] as const

const Body = z.object({
  action: z.enum(ACTIONS),
  text: z.string().trim().min(1).max(8000),
  // Free-form per-action option (target language for 'translate', target
  // tone for 'tone'). Kept loose because the prompts already constrain it.
  option: z.string().trim().max(120).optional(),
})

type Action = typeof ACTIONS[number]

function systemPromptFor(action: Action, option: string | undefined): string {
  // Common preamble: every action is a single-turn rewrite that returns the
  // transformed text only — no preamble, no markdown fence, no commentary.
  const baseRules = [
    'Return only the rewritten text.',
    'No preface, no quotes around the output, no commentary.',
    'Preserve the user\'s original markdown formatting unless the action explicitly changes it.',
  ].join(' ')

  switch (action) {
    case 'improve':
      return `You are a careful editor. Improve grammar, spelling and fluency of the user's text without changing its meaning, length, tone, or formatting. Reply in the same language as the input. ${baseRules}`
    case 'summarize':
      return `Summarize the user's text in 1–3 short sentences. Reply in the same language as the input. ${baseRules}`
    case 'translate': {
      const lang = option && option.length > 0 ? option : 'English'
      return `Translate the user's text into ${lang}. Preserve markdown structure (headings, lists, code blocks) exactly. ${baseRules}`
    }
    case 'continue':
      return `Continue the user's text naturally in the same voice, style and language. Add 1–3 short paragraphs (or 3–6 bullets if the input is a list). Do NOT repeat the input. ${baseRules}`
    case 'explain':
      return `Reformulate the user's text in plain language so a beginner could understand it. Keep the same language as the input. Shorter sentences, no jargon. ${baseRules}`
    case 'tone': {
      const tone = option && option.length > 0 ? option : 'more formal'
      return `Rewrite the user's text to be ${tone}. Keep meaning and language identical. ${baseRules}`
    }
  }
}

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = await readValidatedBody(event, (v) => Body.parse(v))

  const messages: MistralMessage[] = [
    { role: 'system', content: systemPromptFor(body.action, body.option) },
    { role: 'user', content: body.text },
  ]

  // SSE response headers (mirror server/api/ai/chat.post.ts).
  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setHeader(event, 'Connection', 'keep-alive')
  setHeader(event, 'X-Accel-Buffering', 'no')

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      function emit(payload: object): void {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }
      try {
        for await (const delta of mistralChatStream({ messages, temperature: 0.3 })) {
          if (delta.length > 0) emit({ type: 'delta', text: delta })
        }
        emit({ type: 'done' })
      }
      catch (err) {
        const detail = (err as { data?: { detail?: string } })?.data?.detail
          ?? (err as Error)?.message
          ?? 'transform_failed'
        emit({ type: 'error', detail })
      }
      finally {
        controller.close()
      }
    },
  })

  return stream
})
