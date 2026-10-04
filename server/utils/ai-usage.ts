/**
 * Fire-and-forget writer for `ai_usage_logs`, shared by every provider wrapper
 * (`claude.ts` for generation, `mistral.ts` for embeddings + OCR). The admin
 * AI-usage panel groups on `model`, so each wrapper logs its own model id.
 */
import { useDb } from '~/server/database/client'
import { aiUsageLogs } from '~/server/database/schema'

export function logAiUsage(
  userId: number | undefined,
  model: string,
  operation: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  success: boolean = true,
  latencyMs?: number,
  errorCode?: string,
): void {
  // We still log unauthenticated calls when they FAIL so error rates surface
  // in the admin panel; successful unauthenticated calls don't have a useful
  // owner and are skipped.
  if (!userId && success) return
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(aiUsageLogs).values({
        userId: userId ?? null,
        model,
        operation,
        promptTokens,
        completionTokens,
        totalTokens,
        success,
        latencyMs: latencyMs ?? null,
        errorCode: errorCode ?? null,
      })
    }
    catch { /* never surface logging errors */ }
  })
}
