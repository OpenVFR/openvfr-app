import { describe, it, expect } from 'vitest'
import { resolveMsaMargins, DEFAULT_MSA_MARGINS } from './msaMargins'
import { computeMsaProfile } from './virtualRadarCalc'
import { requiredLegAltFt } from './autoCruiseLevel'

describe('resolveMsaMargins', () => {
  it('defaults and clamps', () => {
    expect(resolveMsaMargins()).toEqual(DEFAULT_MSA_MARGINS)
    expect(resolveMsaMargins({ abeamNm: -3, terrainClearanceFt: NaN, obstacleClearanceFt: 99999 }))
      .toEqual({ abeamNm: 0, terrainClearanceFt: 1000, obstacleClearanceFt: 5000 })
  })
})

describe('computeMsaProfile margins', () => {
  const pts = [0, 10, 20, 30].map((d, i) => ({ distNm: d, elevFt: i === 1 ? 2000 : 100 }))
  it('keeps old behaviour by default (5 NM, +1000, round up 100)', () => {
    const m = computeMsaProfile(pts)
    expect(m[0].msaFt).toBe(1100)   // peak at 10 NM is outside 5 NM of 0
    expect(m[1].msaFt).toBe(3000)
  })
  it('wider abeam reaches the peak', () => {
    expect(computeMsaProfile(pts, { abeamNm: 10 })[0].msaFt).toBe(3000)
  })
  it('custom vertical clearance', () => {
    expect(computeMsaProfile(pts, { terrainClearanceFt: 500 })[1].msaFt).toBe(2500)
  })
  it('obstacle raises MSA within the corridor only', () => {
    const m = computeMsaProfile(pts, null, [{ distNm: 20, elevationFt: 2650 }])
    expect(m[2].msaFt).toBe(3200)   // 2650 + 500 -> 3200
    expect(m[0].msaFt).toBe(1100)
  })
  it('sea level with no obstacle stays 0', () => {
    expect(computeMsaProfile([{ distNm: 0, elevFt: 0 }])[0].msaFt).toBe(0)
  })
})

describe('requiredLegAltFt margins', () => {
  it('uses custom margins', () => {
    expect(requiredLegAltFt([1500], [], { terrainClearanceFt: 2000 })).toBe(3500)
    expect(requiredLegAltFt([], [1230], { obstacleClearanceFt: 1000 })).toBe(2300)
  })
})
