import { describe, expect, it } from 'vitest'
import {
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  colorForUser,
  initialsFor,
  isWriteSyncType,
  labelForUser,
  pickLeaderClientId,
} from '~/utils/collab'

describe('pickLeaderClientId', () => {
  it('picks the lowest clientID among editors', () => {
    const states: [number, { user?: { canEdit: boolean } }][] = [
      [42, { user: { canEdit: true } }],
      [7, { user: { canEdit: true } }],
      [99, { user: { canEdit: true } }],
    ]
    expect(pickLeaderClientId(states)).toBe(7)
  })

  it('never elects a viewer, even with the lowest id', () => {
    expect(pickLeaderClientId([
      [1, { user: { canEdit: false } }],
      [5, { user: { canEdit: true } }],
    ])).toBe(5)
  })

  it('ignores clients without a user field yet', () => {
    expect(pickLeaderClientId([[1, {}], [2, undefined], [3, { user: { canEdit: true } }]])).toBe(3)
  })

  it('returns null with no editor', () => {
    expect(pickLeaderClientId([[1, { user: { canEdit: false } }]])).toBeNull()
    expect(pickLeaderClientId([])).toBeNull()
  })
})

describe('isWriteSyncType (viewer filter)', () => {
  it('lets a state-vector request through', () => {
    expect(isWriteSyncType(SYNC_STEP1)).toBe(false)
  })
  it('blocks content-bearing frames', () => {
    expect(isWriteSyncType(SYNC_STEP2)).toBe(true)
    expect(isWriteSyncType(SYNC_UPDATE)).toBe(true)
  })
})

describe('user presentation', () => {
  it('gives a user the same colour every time', () => {
    expect(colorForUser(12)).toBe(colorForUser(12))
    expect(colorForUser(12)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('spreads consecutive ids over different colours', () => {
    const colours = new Set([1, 2, 3, 4, 5].map(colorForUser))
    expect(colours.size).toBeGreaterThan(3)
  })

  it('labels with the display name, else the email local part', () => {
    expect(labelForUser({ email: 'ada@example.com', displayName: ' Ada L. ' })).toBe('Ada L.')
    expect(labelForUser({ email: 'ada@example.com', displayName: null })).toBe('ada')
  })

  it('builds initials', () => {
    expect(initialsFor('Ada Lovelace')).toBe('AL')
    expect(initialsFor('jean-pierre.dupont')).toBe('JD')
    expect(initialsFor('ada')).toBe('A')
  })
})
