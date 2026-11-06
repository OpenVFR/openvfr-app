import { describe, it, expect } from 'vitest'
import { findFrequencies } from './notamFrequency'

describe('findFrequencies (fixture 18)', () => {
  it('comma and dot both give 118.105', () => {
    expect(findFrequencies('CONTACT 118,105').map(f => f.mhz)).toEqual([118.105])
    expect(findFrequencies('CONTACT 118.105').map(f => f.mhz)).toEqual([118.105])
  })
  it('not frequencies: wind, phone and fax numbers, out of band, with a unit', () => {
    expect(findFrequencies('RWY 09 WIND 250.5 KT')).toEqual([])
    expect(findFrequencies('TEL 0046 70 123 456 FAX 070.123')).toEqual([])
    expect(findFrequencies('DIST 120.5 NM')).toEqual([])
    expect(findFrequencies('FL 138.5')).toEqual([])
  })
  it('offsets cover the match', () => {
    const t = 'TWR 118.105 AND 121.5 KT'
    expect(findFrequencies(t).map(f => t.slice(f.start, f.end))).toEqual(['118.105'])
  })
})
