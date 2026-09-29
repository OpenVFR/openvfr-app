import { describe, it, expect } from 'vitest'
import { suggestRouteName } from './suggestRouteName'

describe('suggestRouteName', () => {
  it('names an empty route', () => expect(suggestRouteName([])).toBe('New Route'))
  it('uses the departure alone for one waypoint', () => expect(suggestRouteName([{ name: 'ESMI' }])).toBe('ESMI'))
  it('joins first and last waypoint names', () =>
    expect(suggestRouteName([{ name: 'ESMI' }, { name: 'DOMEN' }, { name: 'ESMS' }])).toBe('ESMI – ESMS'))
  it('falls back to DEP / DEST for unnamed ends', () =>
    expect(suggestRouteName([{}, { name: ' ' }])).toBe('DEP – DEST'))
})
