import { describe, it, expect } from 'vitest'
import { requiredLegAltFt, newLegsAfterChange, autoLevelMessage } from './autoCruiseLevel'

describe('requiredLegAltFt', () => {
  it('is 0 with nothing to clear', () => {
    expect(requiredLegAltFt([0, 0], [])).toBe(0)
    expect(requiredLegAltFt([], [])).toBe(0)
  })
  it('rounds terrain up to 100 ft and adds 800 ft', () => {
    expect(requiredLegAltFt([120, 1510, 800], [])).toBe(2400)
  })
  it('rounds obstacles up to 100 ft and adds 1 000 ft', () => {
    expect(requiredLegAltFt([], [1230])).toBe(2300)
  })
  it('takes the higher of the two', () => {
    expect(requiredLegAltFt([1000], [1700])).toBe(2700)   // obstacle 1700 + 1000
    expect(requiredLegAltFt([2000], [1700])).toBe(2800)   // terrain 2000 + 800
  })
})

describe('newLegsAfterChange', () => {
  const a = { lat: 59, lng: 18 }, b = { lat: 60, lng: 18 }, c = { lat: 61, lng: 18 }, d = { lat: 62, lng: 18 }
  it('append gives the last leg', () => {
    expect(newLegsAfterChange([a, b], [a, b, c])).toEqual([1])
    expect(newLegsAfterChange([a], [a, b])).toEqual([0])
  })
  it('insert gives both legs touching the new point', () => {
    expect(newLegsAfterChange([a, c], [a, b, c])).toEqual([0, 1])
  })
  it('prepend gives the first leg', () => {
    expect(newLegsAfterChange([b, c], [a, b, c])).toEqual([0])
  })
  it('ignores moves, removes and loads', () => {
    expect(newLegsAfterChange([a, b, c], [a, d, c])).toEqual([])
    expect(newLegsAfterChange([a, b, c], [a, c])).toEqual([])
    expect(newLegsAfterChange([a, b], [c, d, a])).toEqual([])
    expect(newLegsAfterChange([], [a])).toEqual([])
  })
})

describe('autoLevelMessage', () => {
  it('formats', () => {
    expect(autoLevelMessage('ESSB', 'WP2', 3500)).toBe('ESSB \u2192 WP2 raised to 3,500 ft for terrain/obstacle clearance')
  })
})
