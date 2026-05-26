import { describe, expect, it } from 'vitest'
import { bestSentence, tokenize } from '~/server/utils/best-sentence'

describe('tokenize', () => {
  it('lowercases and drops short / non-word tokens', () => {
    expect(tokenize('Hello, World! 12 1234')).toEqual(['hello', 'world', '1234'])
  })

  it('returns an empty array for an empty string', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('bestSentence', () => {
  it('picks the sentence with the highest token-overlap against the answer', () => {
    const chunk = [
      'The capital of France is Paris and it has many museums.',
      'Bananas are yellow tropical fruits eaten worldwide every day.',
      'Software engineering involves writing and maintaining computer programs.',
    ].join(' ')
    const answer = 'Paris is the capital of France according to the notes.'
    const got = bestSentence(chunk, answer)
    expect(got).toContain('Paris')
    expect(got).toContain('capital')
  })

  it('falls back to the first sentence when answer has no overlapping tokens', () => {
    const chunk = 'Alpha bravo charlie delta echo foxtrot. Golf hotel india juliet kilo lima.'
    // Answer is non-empty but tokenize() filters tokens <=3 chars, so all empty.
    const answer = 'a b c d'
    const got = bestSentence(chunk, answer)
    expect(got.startsWith('Alpha bravo')).toBe(true)
  })

  it('handles an empty chunk by returning an empty string', () => {
    expect(bestSentence('', 'some answer text here')).toBe('')
  })

  it('handles a chunk with no terminator (single short sentence)', () => {
    // No sentence reaches the >=20-char threshold after split.
    const chunk = 'short'
    expect(bestSentence(chunk, 'whatever the answer is')).toBe('short')
  })

  it('truncates when no sentence reaches the 20-char minimum', () => {
    // Chunk has terminators but every sentence is < 20 chars, so the
    // sentences array is empty and the cleaned text is sliced to 320.
    const chunk = ('hi! '.repeat(200)).trim() // sentences are all 2 chars
    const got = bestSentence(chunk, 'irrelevant answer text')
    expect(got.length).toBeLessThanOrEqual(320)
    expect(got.startsWith('hi')).toBe(true)
  })
})
