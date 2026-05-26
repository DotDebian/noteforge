/**
 * Helpers for getting / setting the authenticated user's Data Encryption
 * Key on the H3 event. The DEK is parked on the session cookie (which
 * `nuxt-auth-utils` encrypts with `NUXT_SESSION_PASSWORD`) and lifted into
 * `event.context.dek` once per request so downstream helpers
 * (notes service, search, embed-doc) can take a Buffer directly.
 *
 * `getDek` returns `null` when the user is not logged in OR when their
 * session predates the encryption rollout (they'll be re-stamped on
 * their next login via the legacy-migration path in `login.post.ts`).
 */
import type { H3Event } from 'h3'

const DEK_CTX_KEY = '__noteforgeDek__' as const

interface DekContext {
  [DEK_CTX_KEY]?: Buffer | null
}

export async function getDek(event: H3Event): Promise<Buffer | null> {
  const ctx = event.context as unknown as DekContext
  if (ctx[DEK_CTX_KEY] !== undefined) return ctx[DEK_CTX_KEY] ?? null
  const session = await getUserSession(event)
  const raw = session?.dek
  if (!raw || typeof raw !== 'string') {
    ctx[DEK_CTX_KEY] = null
    return null
  }
  try {
    const buf = Buffer.from(raw, 'base64')
    if (buf.byteLength !== 32) {
      ctx[DEK_CTX_KEY] = null
      return null
    }
    ctx[DEK_CTX_KEY] = buf
    return buf
  }
  catch {
    ctx[DEK_CTX_KEY] = null
    return null
  }
}

/** Stash the DEK on the event after a fresh unwrap (e.g. login flow). */
export function setDekOnEvent(event: H3Event, dek: Buffer | null): void {
  const ctx = event.context as unknown as DekContext
  ctx[DEK_CTX_KEY] = dek
}

export function dekToSessionValue(dek: Buffer): string {
  return dek.toString('base64')
}
