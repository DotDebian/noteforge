import { describe, expect, it } from 'vitest'
import { extractCitations } from '~/server/utils/citations'

describe('extractCitations', () => {
  it('extracts a single citation [#1]', () => {
    expect([...extractCitations('See [#1].')]).toEqual([1])
  })

  it('extracts comma-separated each-prefixed [#1, #2]', () => {
    expect([...extractCitations('See [#1, #2].').values()].sort((a, b) => a - b))
      .toEqual([1, 2])
  })

  it('extracts comma-separated one-prefix [#1,2,3]', () => {
    expect([...extractCitations('See [#1,2,3].').values()].sort((a, b) => a - b))
      .toEqual([1, 2, 3])
  })

  it('extracts semicolon-separated [#1; #5]', () => {
    expect([...extractCitations('See [#1; #5].').values()].sort((a, b) => a - b))
      .toEqual([1, 5])
  })

  it('extracts space-separated [#1 #2]', () => {
    expect([...extractCitations('See [#1 #2].').values()].sort((a, b) => a - b))
      .toEqual([1, 2])
  })

  it('returns an empty set when there are no citations', () => {
    expect(extractCitations('There are no citations in this text.').size).toBe(0)
  })

  it('dedupes repeated citations [#3] [#3]', () => {
    const set = extractCitations('See [#3] and again [#3].')
    expect(set.size).toBe(1)
    expect(set.has(3)).toBe(true)
  })

  it('handles multiple separate citation blocks', () => {
    const set = extractCitations('First [#1], then [#2, #3], and finally [#4].')
    expect([...set.values()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('ignores zero / negative numbers', () => {
    // The regex only matches digit runs and requires n >= 1; "[#0]" is permitted by
    // the pattern but filtered by the n >= 1 check.
    const set = extractCitations('Bogus [#0] and real [#2].')
    expect(set.has(0)).toBe(false)
    expect(set.has(2)).toBe(true)
  })
})
