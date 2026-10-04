/**
 * Tracks the last time a call to each AI provider succeeded so /api/health can
 * report a lightweight liveness signal without making real API calls itself.
 *
 * `recordProviderSuccess()` is invoked from the provider wrappers
 * (`claude.ts`, `embeddings.ts`) after each successful call.
 * `getProviderStatus()` returns `"ok"` if any success was recorded within the
 * last 5 minutes, else `"unknown"`.
 */

export type AiProvider = 'claude' | 'voyage'

const FRESH_WINDOW_MS = 5 * 60 * 1000

const lastSuccessAt = new Map<AiProvider, number>()

export function recordProviderSuccess(provider: AiProvider): void {
  lastSuccessAt.set(provider, Date.now())
}

export function getProviderStatus(provider: AiProvider): 'ok' | 'unknown' {
  const at = lastSuccessAt.get(provider)
  if (at === undefined) return 'unknown'
  return Date.now() - at <= FRESH_WINDOW_MS ? 'ok' : 'unknown'
}
