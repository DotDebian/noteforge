/**
 * Symmetric encryption primitives for NoteForge's at-rest user-data
 * confidentiality layer.
 *
 * Design (see CLAUDE.md → Confidentialité):
 *   - Each user has a random Data Encryption Key (DEK) — 32 bytes — that
 *     encrypts their owned content (titles, markdown, chunks, chat history,
 *     analyses, version snapshots).
 *   - The DEK is wrapped (encrypted) by a Key Derivation Key (KDK) derived
 *     from the user's password via scrypt. Wrapped DEK lives on the `users`
 *     row; the clear DEK is never persisted.
 *   - A separate wrap of the DEK is made with a key derived from a 24-char
 *     base32 *recovery key*, shown to the user once at registration. That
 *     gives a single fallback path: recovery key + new password → DEK
 *     re-wrapped under the new KDK.
 *   - At login the DEK is unwrapped server-side and parked in the encrypted
 *     session cookie (handled by `nuxt-auth-utils`). Each request fetches
 *     it via `getDek(event)`.
 *   - MCP tokens are wrapped separately: a per-token wrap key is derived
 *     via HKDF over the high-entropy token string, the wrapped DEK lives on
 *     the `mcp_tokens` row.
 *
 * Envelope format for individual fields: `enc:v1:<base64url(iv || tag || ct)>`.
 * The `enc:v1:` prefix makes the encrypted state self-describing — read
 * paths can call `decryptField` blindly and plaintext / legacy rows fall
 * through unchanged. Once `users.encryptionEnabled = 1` every new write
 * goes through `encryptField`.
 *
 * Threat model covered: stolen `data/noteforge.db` (notes unreadable
 * without the user's password OR recovery key).
 * Threat model NOT covered: live server compromise (DEK lives in memory
 * during sessions), Mistral API (plaintext leaves the server for
 * analyze/embed/chat). Embeddings + FTS5 stay unencrypted so retrieval
 * keeps working — they expose topical/term-level fingerprints but not raw
 * note bodies.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const ENVELOPE_PREFIX = 'enc:v1:'
const DEK_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const RECOVERY_KEY_BYTES = 18 // → 24 base32 chars (no padding)
const SCRYPT_N = 1 << 14 // 16384 — CPU/memory cost
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/*  Low-level random + KDFs                                                    */
/* -------------------------------------------------------------------------- */

export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES)
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES)
}

/**
 * Derive a 32-byte Key Derivation Key from a password + salt via scrypt.
 * Sync because Nitro's H3 handlers run on the libuv pool already; scrypt
 * via the async API doesn't buy anything here.
 */
export function deriveKdk(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, DEK_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer
}

/**
 * Derive a per-token wrap key from an MCP bearer token. The bearer is
 * already 256 bits of entropy so HKDF (cheap) is enough — no scrypt needed.
 * The `salt` is the global TOKEN_HKDF_SALT below; `info` separates the
 * domain so the same IKM never produces the same key for two different
 * uses.
 */
const TOKEN_HKDF_SALT = Buffer.from('noteforge-mcp-token-v1', 'utf-8')
export function deriveTokenWrapKey(token: string): Buffer {
  const raw = hkdfSync('sha256', Buffer.from(token, 'utf-8'), TOKEN_HKDF_SALT, Buffer.from('dek-wrap', 'utf-8'), DEK_BYTES)
  return Buffer.from(raw)
}

/* -------------------------------------------------------------------------- */
/*  Recovery key                                                               */
/* -------------------------------------------------------------------------- */

/** Crockford base32 alphabet — no I/L/O/U to keep human-readable copies safe. */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function bytesToBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      const idx = (value >>> (bits - 5)) & 0x1f
      out += BASE32_ALPHABET[idx]
      bits -= 5
    }
  }
  if (bits > 0) {
    const idx = (value << (5 - bits)) & 0x1f
    out += BASE32_ALPHABET[idx]
  }
  return out
}

function base32ToBytes(s: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('Invalid recovery key character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * Normalise a user-typed recovery key: uppercase, strip spaces/hyphens, map
 * commonly-confused chars (1→I dropped from alphabet, here we keep things
 * permissive: I→1, L→1, O→0).
 */
export function normaliseRecoveryKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
}

export function generateRecoveryKey(): { display: string, normalised: string, bytes: Buffer } {
  const bytes = randomBytes(RECOVERY_KEY_BYTES)
  const b32 = bytesToBase32(bytes)
  // Group as 4 × 6 chars for legibility: K7XQ9P-LM3T4R-V8H2NW-DCBFGY
  const groups: string[] = []
  for (let i = 0; i < b32.length; i += 6) groups.push(b32.slice(i, i + 6))
  const display = groups.join('-')
  return { display, normalised: b32, bytes }
}

export function recoveryKeyToBytes(normalised: string): Buffer {
  return base32ToBytes(normalised)
}

export function hashRecoveryKey(normalised: string): string {
  return createHash('sha256').update(normalised, 'utf-8').digest('hex')
}

export function deriveRecoveryWrapKey(normalised: string, salt: Buffer): Buffer {
  // The recovery key is already high-entropy random — HKDF is sufficient
  // (no scrypt cost). Domain-separated from the password KDK by `info`.
  const raw = hkdfSync('sha256', Buffer.from(normalised, 'utf-8'), salt, Buffer.from('recovery-wrap', 'utf-8'), DEK_BYTES)
  return Buffer.from(raw)
}

/* -------------------------------------------------------------------------- */
/*  Symmetric wrap/unwrap (AES-256-GCM)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt a raw byte payload under `key`. Returns `iv || tag || ciphertext`.
 * Use for wrapping the DEK with the KDK / recovery-wrap-key / token-wrap-key.
 */
export function wrap(plaintext: Buffer, key: Buffer): Buffer {
  if (key.byteLength !== DEK_BYTES) throw new Error('wrap: key must be 32 bytes')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

/** Reverses `wrap`. Throws if the authentication tag fails. */
export function unwrap(blob: Buffer, key: Buffer): Buffer {
  if (key.byteLength !== DEK_BYTES) throw new Error('unwrap: key must be 32 bytes')
  if (blob.byteLength < IV_BYTES + TAG_BYTES) {
    throw new Error('unwrap: payload too short')
  }
  const iv = blob.subarray(0, IV_BYTES)
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ct = blob.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** Constant-time comparison helper (avoid leaking via early-return). */
export function ctEquals(a: Buffer, b: Buffer): boolean {
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/* -------------------------------------------------------------------------- */
/*  Field-level envelope (string in, string out)                               */
/* -------------------------------------------------------------------------- */

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX)
}

/**
 * Encrypt a string field. Returns `enc:v1:<base64url>`. If `dek` is null
 * the input passes through unchanged — lets callers run encryption only
 * for users who've finished the legacy migration.
 *
 * Empty strings ARE encrypted (a fresh `''` ciphertext per write avoids
 * leaking "this field is empty" via length).
 */
export function encryptField(plaintext: string, dek: Buffer | null | undefined): string {
  if (!dek) return plaintext
  if (isEncrypted(plaintext)) return plaintext // already encrypted — idempotent
  const buf = Buffer.from(plaintext, 'utf-8')
  const wrapped = wrap(buf, dek)
  return ENVELOPE_PREFIX + wrapped.toString('base64url')
}

/**
 * Optional metadata callers may attach when decrypting a field, so failure
 * paths can record which entity/field tripped them in
 * `decryption_failures`. Purely advisory — `decryptField` works without it.
 */
export interface DecryptFieldContext {
  userId?: number
  entityType?: string
  entityId?: number
  field?: string
}

/**
 * Decrypt a string field. If the value isn't in envelope form, returns it
 * unchanged (plaintext / legacy). If `dek` is null, returns the input
 * unchanged too — used during the migration window. Throws only on a
 * tampered/corrupt envelope.
 *
 * When `ctx` is supplied AND decryption fails, the error is logged to
 * `decryption_failures` (fire-and-forget) before being re-thrown. We import
 * the logger lazily so this module stays free of DB deps at module-init
 * time (`useDb()` would otherwise load on first import).
 */
export function decryptField(
  value: string | null | undefined,
  dek: Buffer | null | undefined,
  ctx?: DecryptFieldContext,
): string {
  if (value == null) return ''
  if (!isEncrypted(value)) return value
  if (!dek) return value // can't decrypt without DEK — return raw envelope (caller surfaces an error)
  try {
    const blob = Buffer.from(value.slice(ENVELOPE_PREFIX.length), 'base64url')
    const plain = unwrap(blob, dek)
    return plain.toString('utf-8')
  }
  catch (err) {
    if (ctx) {
      // Lazy import to keep crypto.ts free of database imports at load.
      // The logger is fire-and-forget so even if THIS import fails (e.g.
      // during very early bootstrap) we still re-throw the original error.
      void import('./decryptionFailures')
        .then(({ logDecryptionFailure }) => {
          logDecryptionFailure({
            userId: ctx.userId,
            entityType: ctx.entityType ?? 'unknown',
            entityId: ctx.entityId,
            field: ctx.field ?? 'unknown',
            errorMessage: (err as Error).message,
          })
        })
        .catch(() => { /* swallow */ })
    }
    throw err
  }
}

/** Convenience: decrypt a JSON-serialised field, returning the parsed value. */
export function decryptJsonField<T>(value: string | null | undefined, dek: Buffer | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback
  const raw = decryptField(value, dek)
  if (raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  }
  catch {
    return fallback
  }
}

export function encryptJsonField(value: unknown, dek: Buffer | null | undefined): string {
  return encryptField(JSON.stringify(value), dek)
}
