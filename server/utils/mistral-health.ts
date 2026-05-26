/**
 * Tracks the last time a Mistral API call succeeded so /api/health can report
 * a lightweight liveness signal without making real API calls itself.
 *
 * `recordMistralSuccess()` is invoked from `server/utils/mistral.ts` after each
 * successful chat / stream / embed call. `getMistralStatus()` returns `"ok"`
 * if any success was recorded within the last 5 minutes, else `"unknown"`.
 */

const FRESH_WINDOW_MS = 5 * 60 * 1000

let lastSuccessAt: number | null = null

export function recordMistralSuccess(): void {
  lastSuccessAt = Date.now()
}

export function getMistralStatus(): 'ok' | 'unknown' {
  if (lastSuccessAt === null) return 'unknown'
  if (Date.now() - lastSuccessAt <= FRESH_WINDOW_MS) return 'ok'
  return 'unknown'
}
