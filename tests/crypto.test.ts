/**
 * Round-trip coverage for the at-rest encryption primitives.
 *
 * - field envelope (encrypt → decrypt)
 * - DEK wrap/unwrap under a password-derived KDK
 * - recovery key round-trip + normaliser tolerance to spaces / hyphens / case
 * - tamper detection on the auth tag
 * - opt-out (no DEK) returns input unchanged so legacy plaintext flows
 */
import { describe, expect, it } from 'vitest'
import {
  decryptField,
  deriveKdk,
  deriveRecoveryWrapKey,
  encryptField,
  generateDek,
  generateRecoveryKey,
  generateSalt,
  generateUserKeyPair,
  generateWek,
  hashRecoveryKey,
  isEncrypted,
  normaliseRecoveryKey,
  openSealed,
  sealForPublicKey,
  unwrap,
  wrap,
} from '../server/utils/crypto'

describe('field envelope', () => {
  const dek = generateDek()

  it('round-trips a string', () => {
    const enc = encryptField('hello world', dek)
    expect(enc.startsWith('enc:v1:')).toBe(true)
    expect(decryptField(enc, dek)).toBe('hello world')
  })

  it('round-trips empty strings', () => {
    const enc = encryptField('', dek)
    expect(isEncrypted(enc)).toBe(true)
    expect(decryptField(enc, dek)).toBe('')
  })

  it('passes through when no DEK is given', () => {
    expect(encryptField('x', null)).toBe('x')
    expect(decryptField('x', null)).toBe('x')
    // Encrypted envelope without DEK is left as-is (caller surfaces error).
    const ct = encryptField('x', dek)
    expect(decryptField(ct, null)).toBe(ct)
  })

  it('passes plaintext through on decrypt (legacy rows)', () => {
    expect(decryptField('not an envelope', dek)).toBe('not an envelope')
  })

  it('detects tampering', () => {
    const ct = encryptField('secret', dek)
    // Flip one byte of base64 payload
    const tampered = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + ct.slice(-1)
    expect(() => decryptField(tampered, dek)).toThrow()
  })

  it('uses fresh IVs (two encryptions of same plaintext differ)', () => {
    const a = encryptField('same', dek)
    const b = encryptField('same', dek)
    expect(a).not.toBe(b)
    expect(decryptField(a, dek)).toBe('same')
    expect(decryptField(b, dek)).toBe('same')
  })
})

describe('DEK wrap under KDK', () => {
  it('round-trips via scrypt-derived KDK', () => {
    const salt = generateSalt()
    const dek = generateDek()
    const kdk = deriveKdk('correct horse battery staple', salt)
    const wrapped = wrap(dek, kdk)
    const unwrapped = unwrap(wrapped, kdk)
    expect(unwrapped.equals(dek)).toBe(true)
  })

  it('fails with the wrong password', () => {
    const salt = generateSalt()
    const dek = generateDek()
    const kdk = deriveKdk('right password', salt)
    const wrapped = wrap(dek, kdk)
    const wrongKdk = deriveKdk('wrong password', salt)
    expect(() => unwrap(wrapped, wrongKdk)).toThrow()
  })
})

describe('recovery key', () => {
  it('normaliser strips spaces / hyphens / case and maps confusables', () => {
    // Crockford alphabet excludes I, L, O, U — but a user reading aloud
    // (or OCR'ing) might type those characters anyway. The normaliser
    // maps them to the closest visually-similar Crockford char:
    // I,L → 1 ; O → 0 ; U → V.
    expect(normaliseRecoveryKey('K7XQ9P-7M3T4R-V8H2NW-DCBFGY')).toBe('K7XQ9P7M3T4RV8H2NWDCBFGY')
    expect(normaliseRecoveryKey('  k7xq9p 7m3t4r v8h2nw dcbfgy ')).toBe('K7XQ9P7M3T4RV8H2NWDCBFGY')
    expect(normaliseRecoveryKey('IL OUI')).toBe('110V1')
  })

  it('round-trips DEK wrapping via recovery wrap key', () => {
    const salt = generateSalt()
    const dek = generateDek()
    const { display, normalised } = generateRecoveryKey()
    expect(display).toMatch(/^[0-9A-Z]+(-[0-9A-Z]+)+$/)
    expect(normalised.length).toBeGreaterThan(0)

    const wrapKey = deriveRecoveryWrapKey(normalised, salt)
    const wrapped = wrap(dek, wrapKey)
    expect(unwrap(wrapped, wrapKey).equals(dek)).toBe(true)

    // User-typed (lowercased, hyphenated) form should also work after normalise.
    const typed = normaliseRecoveryKey(display.toLowerCase())
    const wrapKey2 = deriveRecoveryWrapKey(typed, salt)
    expect(unwrap(wrapped, wrapKey2).equals(dek)).toBe(true)
  })

  it('hashes are deterministic and salted by content only', () => {
    const a = hashRecoveryKey('K7XQ9PLM3T4RV8H2NWDCBFGY')
    const b = hashRecoveryKey('K7XQ9PLM3T4RV8H2NWDCBFGY')
    const c = hashRecoveryKey('OTHER')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(64) // SHA-256 hex
  })
})

describe('X25519 sealed box (workspace sharing)', () => {
  it('round-trips a payload through generate → seal → open', () => {
    const recipient = generateUserKeyPair()
    const wek = generateWek()
    const sealed = sealForPublicKey(wek, recipient.publicKey)
    const opened = openSealed(sealed, recipient.privateKey, recipient.publicKey)
    expect(opened.equals(wek)).toBe(true)
  })

  it('fails when opened with the wrong recipient key', () => {
    const alice = generateUserKeyPair()
    const eve = generateUserKeyPair()
    const wek = generateWek()
    const sealed = sealForPublicKey(wek, alice.publicKey)
    // Eve's private key can't open a box sealed for Alice — AES-GCM tag mismatch.
    expect(() => openSealed(sealed, eve.privateKey, alice.publicKey)).toThrow()
  })

  it('rejects tampered sealed payloads', () => {
    const kp = generateUserKeyPair()
    const sealed = Buffer.from(sealForPublicKey(generateWek(), kp.publicKey))
    // Flip a single byte in the ciphertext region (after ephemeralPub + iv + tag).
    sealed[sealed.byteLength - 1] = (sealed[sealed.byteLength - 1] ?? 0) ^ 0x01
    expect(() => openSealed(sealed, kp.privateKey, kp.publicKey)).toThrow()
  })

  it('each seal uses a fresh ephemeral key', () => {
    const kp = generateUserKeyPair()
    const wek = generateWek()
    const a = sealForPublicKey(wek, kp.publicKey)
    const b = sealForPublicKey(wek, kp.publicKey)
    // First 32 bytes are the ephemeral public key — should differ.
    expect(a.subarray(0, 32).equals(b.subarray(0, 32))).toBe(false)
    expect(openSealed(a, kp.privateKey, kp.publicKey).equals(wek)).toBe(true)
    expect(openSealed(b, kp.privateKey, kp.publicKey).equals(wek)).toBe(true)
  })
})
