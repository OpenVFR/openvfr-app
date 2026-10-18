import { describe, it, expect } from 'vitest'
import { legLabelVariants, formatLegTime } from './legLabels'

describe('legLabelVariants', () => {
  it('builds full, mid and short variants', () => {
    const v = legLabelVariants({ magHdgDeg: 87.6, distNm: 12.34, speedKts: 100 })
    expect(v.short).toBe('088°')
    expect(v.mid).toBe('088°  ·  12 NM')
    expect(v.full).toBe('088°  ·  12 NM  ·  7 min')
  })
  it('keeps a decimal under 10 and converts to km', () => {
    const v = legLabelVariants({ magHdgDeg: 5, distNm: 4.26, unit: 'km' })
    expect(v.mid).toBe('005°  ·  7.9 km')
    expect(v.full).toBe(v.mid) // no speed -> no time
  })
})

describe('formatLegTime', () => {
  it('formats minutes and hours', () => {
    expect(formatLegTime(10, 100)).toBe('6 min')
    expect(formatLegTime(130, 100)).toBe('1 h 18')
  })
})
