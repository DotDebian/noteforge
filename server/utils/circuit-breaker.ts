/**
 * Tiny in-memory circuit breaker for failure-soft auxiliary calls
 * (reranker, rewriter, …).
 *
 * Design:
 *  - We track every failure timestamp inside a rolling 60s window.
 *  - When the window contains `>= failureThreshold` failures, the breaker
 *    "trips" and `isOpen()` returns true for `cooldownMs` from the trip.
 *  - The first successful call after the cooldown clears the state.
 *  - `recordSuccess()` always clears the failure list — a single success
 *    inside the rolling window is treated as a signal that the dependency
 *    is healthy enough to keep trying.
 *
 * Not persisted, not shared across processes: per-instance, single-node only.
 */

export interface CircuitBreakerState {
  recordSuccess(): void
  recordFailure(): void
  isOpen(): boolean
}

export interface CircuitBreakerOptions {
  /** Number of failures within the rolling window required to trip. */
  failureThreshold: number
  /** Once tripped, `isOpen()` returns true for this long (ms). */
  cooldownMs: number
}

/** Rolling window for failure counting. Independent of `cooldownMs`. */
const FAILURE_WINDOW_MS = 60_000

export function createCircuitBreaker(opts: CircuitBreakerOptions): CircuitBreakerState {
  const failures: number[] = []
  let trippedAt: number | null = null

  const prune = (now: number): void => {
    // Drop failures that fell out of the rolling window.
    const cutoff = now - FAILURE_WINDOW_MS
    while (failures.length > 0 && (failures[0] ?? 0) < cutoff) failures.shift()
  }

  return {
    recordSuccess(): void {
      failures.length = 0
      trippedAt = null
    },
    recordFailure(): void {
      const now = Date.now()
      prune(now)
      failures.push(now)
      if (failures.length >= opts.failureThreshold) {
        trippedAt = now
      }
    },
    isOpen(): boolean {
      if (trippedAt === null) return false
      const now = Date.now()
      if (now - trippedAt >= opts.cooldownMs) {
        // Cooldown elapsed → half-open. Clear the trip marker so the next
        // call goes through; if it fails we'll just trip again.
        trippedAt = null
        failures.length = 0
        return false
      }
      return true
    },
  }
}
