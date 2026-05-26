import type { H3Event } from 'h3'
import { createError, setHeader } from 'h3'

/* -------------------------------------------------------------------------- *
 *  In-memory sliding-window rate limiter.
 *
 *  Per-(userId, bucket) we keep a flat array of request timestamps (ms).
 *  On each check we drop entries older than the longest configured window,
 *  then verify every (windowMs, max) pair. If any pair is exceeded we return
 *  the time until the OLDEST entry in that window expires.
 *
 *  NOTE: this store is process-local and does NOT survive restart. For a
 *  single-node deployment that's fine; if we ever scale out, this needs to
 *  move to Redis (or equivalent).
 * -------------------------------------------------------------------------- */

export type Bucket = 'analyze' | 'chat' | 'embed' | 'public-share'

interface Window {
  windowMs: number
  max: number
}

const LIMITS: Record<Bucket, Window[]> = {
  analyze: [
    { windowMs: 60_000, max: 10 },
    { windowMs: 3_600_000, max: 50 },
  ],
  chat: [
    { windowMs: 60_000, max: 30 },
    { windowMs: 3_600_000, max: 200 },
  ],
  embed: [
    { windowMs: 60_000, max: 20 },
  ],
  // Sprint 5 / F9 — public /share/* viewer endpoint. Keyed by client IP since
  // the route is unauthenticated. 30 req/min is generous for a human reader
  // and shuts down trivial scraping loops.
  'public-share': [
    { windowMs: 60_000, max: 30 },
  ],
}

const hits = new Map<string, number[]>()

/** Abuse tracker — userId → timestamps of recent rate-limit hits. */
const abuseHits = new Map<number, number[]>()
const ABUSE_WINDOW_MS = 10 * 60_000
const ABUSE_THRESHOLD = 5

function longestWindow(bucket: Bucket): number {
  let longest = 0
  for (const w of LIMITS[bucket]) {
    if (w.windowMs > longest) longest = w.windowMs
  }
  return longest
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec?: number
}

export function checkRateLimit(userId: number, bucket: Bucket): RateLimitResult {
  return checkRateLimitByKey(String(userId), bucket, userId)
}

/**
 * Variant keyed by an arbitrary string (e.g. client IP for unauthenticated
 * routes). `abuseUserId` is optional — only forwarded into the abuse tracker
 * when we actually have a numeric user.
 */
export function checkRateLimitByKey(
  rawKey: string,
  bucket: Bucket,
  abuseUserId?: number,
): RateLimitResult {
  const now = Date.now()
  const key = `${rawKey}:${bucket}`
  const windows = LIMITS[bucket]
  const longest = longestWindow(bucket)

  const stamps = hits.get(key) ?? []
  // Drop anything older than the longest window for this bucket.
  const fresh = stamps.filter(t => now - t < longest)

  // Find the most-restrictive exceeded window (the one with the smallest
  // retryAfter — i.e. the soonest we'd be allowed again on that window alone).
  let blockedRetryMs = 0
  for (const w of windows) {
    const cutoff = now - w.windowMs
    let count = 0
    let oldestInWindow = Infinity
    for (const t of fresh) {
      if (t >= cutoff) {
        count++
        if (t < oldestInWindow) oldestInWindow = t
      }
    }
    if (count >= w.max && oldestInWindow !== Infinity) {
      const retryMs = oldestInWindow + w.windowMs - now
      if (retryMs > blockedRetryMs) blockedRetryMs = retryMs
    }
  }

  if (blockedRetryMs > 0) {
    // Persist the GC'd window so the array doesn't grow unbounded across
    // the abuse path.
    hits.set(key, fresh)
    const retryAfterSec = Math.max(1, Math.ceil(blockedRetryMs / 1000))
    console.info(`[rate-limit] key ${rawKey} hit limit for bucket ${bucket} (retry in ${retryAfterSec}s)`)
    if (abuseUserId !== undefined) trackAbuse(abuseUserId, now)
    return { allowed: false, retryAfterSec }
  }

  fresh.push(now)
  hits.set(key, fresh)
  return { allowed: true }
}

function trackAbuse(userId: number, now: number): void {
  const existing = abuseHits.get(userId) ?? []
  const fresh = existing.filter(t => now - t < ABUSE_WINDOW_MS)
  fresh.push(now)
  abuseHits.set(userId, fresh)
  if (fresh.length >= ABUSE_THRESHOLD) {
    console.warn(`[rate-limit] user ${userId} abusing — ${fresh.length}+ hits in 10min`)
  }
}

/**
 * Apply a bucket's rate limit to the current event. On reject sets the
 * `Retry-After` header and throws a 429.
 */
export function applyRateLimit(event: H3Event, userId: number, bucket: Bucket): void {
  const result = checkRateLimit(userId, bucket)
  if (result.allowed) return

  const sec = result.retryAfterSec ?? 1
  setHeader(event, 'Retry-After', sec)
  throw createError({
    statusCode: 429,
    statusMessage: `Rate limit exceeded. Try again in ${sec}s.`,
    data: { retryAfterSec: sec },
  })
}

/** Extract the best-effort client IP from an H3 event. */
export function getClientIp(event: H3Event): string {
  // x-forwarded-for can be a comma-separated list — first entry is the
  // original client per the proxy convention.
  const xff = event.node.req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  else if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0]?.split(',')[0]?.trim()
    if (first) return first
  }
  return event.node.req.socket?.remoteAddress ?? 'unknown'
}

/**
 * IP-keyed variant of {@link applyRateLimit}. Use on unauthenticated routes.
 */
export function applyRateLimitByIp(event: H3Event, bucket: Bucket): void {
  const ip = getClientIp(event)
  const result = checkRateLimitByKey(`ip:${ip}`, bucket)
  if (result.allowed) return

  const sec = result.retryAfterSec ?? 1
  setHeader(event, 'Retry-After', sec)
  throw createError({
    statusCode: 429,
    statusMessage: `Rate limit exceeded. Try again in ${sec}s.`,
    data: { retryAfterSec: sec },
  })
}
