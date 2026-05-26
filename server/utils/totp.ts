/**
 * TOTP (RFC 6238) helpers for two-factor authentication.
 *
 * The base32 secret is stored at rest under `user_totp.secretEncrypted`
 * (AES-256-GCM, key derived from NUXT_SESSION_PASSWORD via SHA-256). The DB
 * never sees the plaintext secret after enrollment; decryption happens
 * server-side at verify time only.
 *
 * Backup codes are 8-char base32-ish single-use strings, presented to the
 * user ONCE at enrollment time and persisted as SHA-256 hex. `verifyBackupCode`
 * consumes a code (removes it from the array) on a successful match; the
 * caller is responsible for persisting the updated array.
 *
 * `otplib` v13 reorganised exports — there's no `authenticator` namespace,
 * and `verify` is async by default. We use the `*Sync` variants (which use
 * the bundled Noble crypto plugin) so call sites can stay synchronous.
 */
import crypto from 'node:crypto'
import {
  generateSecret as _generateSecret,
  generateURI,
  verifySync,
} from 'otplib'
import { toDataURL as qrToDataUrl } from 'qrcode'

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard
const TAG_LENGTH = 16

function getKey(): Buffer {
  const pw = process.env.NUXT_SESSION_PASSWORD
  if (!pw || pw.length < 32) {
    throw new Error(
      '[totp] NUXT_SESSION_PASSWORD is required (>= 32 chars) to encrypt/decrypt TOTP secrets.',
    )
  }
  return crypto.createHash('sha256').update(pw).digest()
}

/**
 * Encrypt a base32 TOTP secret. Output layout (base64): `iv(12) | tag(16) | ciphertext`.
 */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc, 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('[totp] ciphertext too short')
  }
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return dec.toString('utf8')
}

/** Generate a fresh base32 TOTP secret (default: 20 bytes / 32 chars). */
export function generateSecret(): string {
  return _generateSecret()
}

/**
 * Verify a 6-digit TOTP code against the secret. Allows ±30s of clock
 * drift via `epochTolerance: 30` — one period either side, matching most
 * authenticator apps' default tolerance and the standard 2FA UX.
 */
export function verifyToken(token: string, secret: string): boolean {
  // Strip spaces (some authenticator apps insert a half-way space).
  const clean = token.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  try {
    const res = verifySync({ token: clean, secret, epochTolerance: 30 })
    return res.valid === true
  }
  catch {
    // Bad secret encoding, malformed token, etc. — treat as a verification
    // failure rather than surfacing a 500 to the caller.
    return false
  }
}

/** Build the `otpauth://` URI for QR rendering. */
export function otpAuthUrl(email: string, secret: string): string {
  return generateURI({ issuer: 'NoteForge', label: email, secret })
}

/** Render an `otpauth://` URI as a PNG data URL ready for an <img src>. */
export async function qrDataUrl(otpauth: string): Promise<string> {
  return qrToDataUrl(otpauth, { errorCorrectionLevel: 'M', margin: 1, width: 220 })
}

/**
 * Generate `n` single-use backup codes. Format: `XXXX-XXXX` (uppercase
 * alphanumeric, confusable chars stripped) so they're memorable to write
 * down. Crypto-random, not derived from the TOTP secret.
 */
export function generateBackupCodes(n = 8): string[] {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // omit confusable I/O/0/1
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const bytes = crypto.randomBytes(8)
    let part = ''
    for (let j = 0; j < 8; j++) {
      const b = bytes[j]
      if (b === undefined) continue
      const ch = ALPHABET[b % ALPHABET.length]
      if (ch !== undefined) part += ch
    }
    out.push(`${part.slice(0, 4)}-${part.slice(4, 8)}`)
  }
  return out
}

/** SHA-256 hex digest of a backup code. Used both for storage and lookup. */
export function hashBackupCode(code: string): string {
  // Normalise: strip spaces + hyphens, uppercase. So "abcd efgh" matches
  // the same row as "ABCD-EFGH".
  const normalised = code.replace(/[\s-]/g, '').toUpperCase()
  return crypto.createHash('sha256').update(normalised).digest('hex')
}

/**
 * Verify a backup code against a stored hashed list. Returns the updated
 * list (with the consumed code removed) when matched, or `null` if no match.
 * Callers MUST persist the returned array — backup codes are single-use.
 */
export function verifyBackupCode(
  code: string,
  hashedList: string[],
): string[] | null {
  const wanted = hashBackupCode(code)
  const idx = hashedList.findIndex((h) => h === wanted)
  if (idx < 0) return null
  const next = hashedList.slice()
  next.splice(idx, 1)
  return next
}
