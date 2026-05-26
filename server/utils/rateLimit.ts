/**
 * Minimal in-memory token-bucket rate limiter for the auth endpoints.
 *
 * Sized for a single Node process — restart-volatile, not cluster-safe. If
 * NoteForge ever scales out, this becomes a Redis-backed counter; the API
 * surface (`consume`) is kept narrow so swapping the store is cheap.
 *
 * Why a second file instead of folding into `rate-limit.ts`?
 *   - `rate-limit.ts` uses a sliding-window log keyed by `(userId, bucket)`
 *     with bucket-specific limits hard-coded. Auth needs per-call-site
 *     control over `(limit, windowMs)` so we expose the simpler `consume`
 *     primitive here. Auth also needs to key by both IP and email — both
 *     unauthenticated identifiers — without polluting the bucket enum.
 */

interface Counter {
  count: number
  resetAt: number
}

const buckets = new Map<string, Counter>()

export interface ConsumeResult {
  ok: boolean
  retryAfterMs: number
}

/**
 * Consume one token for `key` against a window of `windowMs` allowing up to
 * `limit` events. Returns `{ ok: true, retryAfterMs: 0 }` while under limit,
 * `{ ok: false, retryAfterMs }` once exceeded — `retryAfterMs` is the ms
 * until the current window ends (>= 1).
 */
export function consume(key: string, limit: number, windowMs: number): ConsumeResult {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterMs: 0 }
  }

  if (existing.count >= limit) {
    const retryAfterMs = Math.max(1, existing.resetAt - now)
    return { ok: false, retryAfterMs }
  }

  existing.count += 1
  return { ok: true, retryAfterMs: 0 }
}

/**
 * Roll back a single increment for `key`. Used so a successful login doesn't
 * consume the "failed attempts" allowance for that email.
 */
export function release(key: string): void {
  const existing = buckets.get(key)
  if (!existing) return
  if (existing.count <= 1) {
    buckets.delete(key)
    return
  }
  existing.count -= 1
}

/** Test-only helper — clears all counters. Not used in production code. */
export function _resetAll(): void {
  buckets.clear()
}
