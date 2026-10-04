import { describe, it, expect } from 'vitest'
import { computeMapScale, formatScaleRatio } from './mapScale'

describe('mapScale', () => {
  it('picks a 1/2/5 NM value that fits the max bar width', () => {
    const s = computeMapScale(60, 10, true, 110)
    expect(s.label).toMatch(/^(1|2|5|10|20) NM$/)
    expect(s.barPx).toBeGreaterThan(0)
    expect(s.barPx).toBeLessThanOrEqual(110)
  })
  it('falls back to metres below 1 km', () => {
    expect(computeMapScale(60, 17, false, 110).label).toMatch(/ m$/)
  })
  it('formats ratios', () => {
    expect(formatScaleRatio(250_000)).toBe('1:250k')
    expect(formatScaleRatio(2_500_000)).toBe('1:2.5M')
    expect(formatScaleRatio(800)).toBe('1:800')
  })
})
