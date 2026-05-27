/**
 * MCP tool-call instrumentation. One row per tool invocation with the
 * tool name, success/failure, latency, and error code if any.
 *
 * Fire-and-forget.
 */
import { useDb } from '~/server/database/client'
import { mcpCallLogs } from '~/server/database/schema'

export function logMcpCall(opts: {
  tokenId?: number
  userId?: number
  toolName: string
  success: boolean
  latencyMs?: number
  errorCode?: string
}): void {
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(mcpCallLogs).values({
        tokenId: opts.tokenId ?? null,
        userId: opts.userId ?? null,
        toolName: opts.toolName,
        success: opts.success,
        latencyMs: opts.latencyMs ?? null,
        errorCode: opts.errorCode ?? null,
      })
    }
    catch { /* swallow */ }
  })
}
