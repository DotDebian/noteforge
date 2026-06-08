import { describe, expect, it } from 'vitest'
import { normalizeTitle, scoreTitleMatch, TITLE_MATCH_MIN_SCORE } from '~/server/utils/title-match'

describe('normalizeTitle', () => {
  it('folds accents, case and punctuation', () => {
    expect(normalizeTitle('Réunion d\'équipe — Q3')).toBe('reunion d equipe q3')
  })

  it('collapses whitespace runs and trims', () => {
    expect(normalizeTitle('  Hello   World  ')).toBe('hello world')
  })

  it('keeps digits', () => {
    expect(normalizeTitle('2026-06-07')).toBe('2026 06 07')
  })

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeTitle('?!… —')).toBe('')
  })
})

describe('scoreTitleMatch', () => {
  it('scores an exact (normalised) match 1', () => {
    expect(scoreTitleMatch('réunion équipe', 'Reunion equipe')).toBe(1)
  })

  it('scores a prefix match 0.9', () => {
    expect(scoreTitleMatch('roadmap', 'Roadmap 2026 produit')).toBe(0.9)
  })

  it('scores a substring match 0.75', () => {
    expect(scoreTitleMatch('machin', 'La grosse machine à café')).toBe(0.75)
  })

  it('scores all-tokens-present (any order) 0.7', () => {
    expect(scoreTitleMatch('équipe réunion', 'Réunion de l\'équipe produit')).toBe(0.7)
  })

  it('scores partial token overlap proportionally, below 0.7', () => {
    const score = scoreTitleMatch('réunion budget marketing', 'Réunion produit')
    expect(score).toBeGreaterThanOrEqual(TITLE_MATCH_MIN_SCORE)
    expect(score).toBeLessThan(0.7)
  })

  it('scores no-overlap 0', () => {
    expect(scoreTitleMatch('facture', 'Notes de voyage')).toBe(0)
  })

  it('handles empty inputs', () => {
    expect(scoreTitleMatch('', 'Anything')).toBe(0)
    expect(scoreTitleMatch('anything', '')).toBe(0)
    expect(scoreTitleMatch('—', 'Anything')).toBe(0)
  })

  it('ranks closer titles higher', () => {
    const exact = scoreTitleMatch('budget 2026', 'Budget 2026')
    const prefix = scoreTitleMatch('budget', 'Budget 2026')
    const fuzzy = scoreTitleMatch('2026 budget', 'Budget 2026 prévisionnel')
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(fuzzy)
  })
})
