import { describe, expect, it } from 'vitest'
import {
  bufferToFloats,
  cosineSimilarity,
  floatsToBuffer,
  loadEmbedding,
  parseEmbedding,
  serializeEmbedding,
} from '~/server/utils/vector'

describe('cosineSimilarity', () => {
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('returns 1 for parallel vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10)
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10)
  })

  it('returns -1 for anti-parallel vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10)
  })

  it('uses min length when lengths mismatch', () => {
    // With min-length behavior, [1,0,99] vs [1,0] truncates to [1,0] vs [1,0] = 1.
    expect(cosineSimilarity([1, 0, 99], [1, 0])).toBeCloseTo(1, 10)
  })

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0)
  })

  it('returns 0 when one vector is all zeros (denominator 0)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })
})

describe('parseEmbedding', () => {
  it('round-trips a valid JSON array via serializeEmbedding', () => {
    const vec = [0.1, -0.2, 3, 4.5]
    expect(parseEmbedding(serializeEmbedding(vec))).toEqual(vec)
  })

  it('returns [] for null', () => {
    expect(parseEmbedding(null)).toEqual([])
  })

  it('returns [] for undefined', () => {
    expect(parseEmbedding(undefined)).toEqual([])
  })

  it('returns [] for empty string', () => {
    expect(parseEmbedding('')).toEqual([])
  })

  it('returns [] for invalid JSON', () => {
    expect(parseEmbedding('not json at all')).toEqual([])
    expect(parseEmbedding('{invalid}')).toEqual([])
  })

  it('returns [] for non-array JSON', () => {
    expect(parseEmbedding('{"a":1}')).toEqual([])
    expect(parseEmbedding('"string"')).toEqual([])
    expect(parseEmbedding('42')).toEqual([])
  })

  it('filters out non-finite / non-number entries', () => {
    expect(parseEmbedding('[1, "x", null, 2, true, 3]')).toEqual([1, 2, 3])
  })
})

describe('floatsToBuffer / bufferToFloats', () => {
  it('round-trips a vector through Float32 within 1e-6 precision', () => {
    const vec = [0.1, -0.2, 3, 4.5, -1e-3, 0, 12345.625]
    const buf = floatsToBuffer(vec)
    expect(buf.byteLength).toBe(vec.length * 4)
    const back = bufferToFloats(buf)
    expect(back).toHaveLength(vec.length)
    for (let i = 0; i < vec.length; i++) {
      expect(back[i]).toBeCloseTo(vec[i] ?? 0, 6)
    }
  })

  it('preserves exact-representable Float32 values bit-perfectly', () => {
    // 0.5, 0.25, 1.0 etc. are exactly representable in IEEE-754 float32.
    const vec = [0.5, -0.25, 1, -2, 1024, -0.125]
    const back = bufferToFloats(floatsToBuffer(vec))
    expect(back).toEqual(vec)
  })

  it('returns [] for a null / undefined / empty buffer', () => {
    expect(bufferToFloats(null)).toEqual([])
    expect(bufferToFloats(undefined)).toEqual([])
    expect(bufferToFloats(Buffer.alloc(0))).toEqual([])
  })

  it('returns [] when the buffer length is not a multiple of 4', () => {
    expect(bufferToFloats(Buffer.from([1, 2, 3]))).toEqual([])
    expect(bufferToFloats(Buffer.from([1, 2, 3, 4, 5]))).toEqual([])
  })
})

describe('loadEmbedding', () => {
  it('prefers BLOB over TEXT when both are present', () => {
    const blobVec = [0.5, -0.25, 0.125]
    const textVec = [9, 9, 9]
    const v = loadEmbedding({
      embeddingBlob: floatsToBuffer(blobVec),
      embedding: serializeEmbedding(textVec),
    })
    expect(v).toEqual(blobVec)
  })

  it('falls back to TEXT when BLOB is null', () => {
    const textVec = [1, 2, 3]
    const v = loadEmbedding({
      embeddingBlob: null,
      embedding: serializeEmbedding(textVec),
    })
    expect(v).toEqual(textVec)
  })

  it('falls back to TEXT when BLOB is an empty buffer', () => {
    const textVec = [4, 5, 6]
    const v = loadEmbedding({
      embeddingBlob: Buffer.alloc(0),
      embedding: serializeEmbedding(textVec),
    })
    expect(v).toEqual(textVec)
  })

  it('returns [] when both columns are missing', () => {
    expect(loadEmbedding({ embeddingBlob: null, embedding: null })).toEqual([])
    expect(loadEmbedding({})).toEqual([])
  })
})
