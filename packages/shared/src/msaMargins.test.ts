import { describe, it, expect } from 'vitest'
import { resolveMsaMargins, DEFAULT_MSA_MARGINS } from './msaMargins'
import { computeMsaProfile } from './virtualRadarCalc'
import { requiredLegAltFt } from './autoCruiseLevel'

describe('resolveMsaMargins', () => {
  it('defaults and clamps', () => {
    expect(resolveMsaMargins()).toEqual(DEFAULT_MSA_MARGINS)
    expect(resolveMsaMargins({ abeamNm: -3, terrainClearanceFt: NaN, obstacleClearanceFt: 99999 }))
      .toEqual({ abeamNm: 1, terrainClearanceFt: 800, obstacleClearanceFt: 2000 })   // limits 1-10 NM, 300-2000 ft
  })
})

describe('computeMsaProfile margins', () => {
  const pts = [0, 10, 20, 30].map((d, i) => ({ distNm: d, elevFt: i === 1 ? 2000 : 100 }))
  it('defaults: 5 NM abeam, terrain +800 ft, rounded up to 100 ft', () => {
    const m = computeMsaProfile(pts)
    expect(m[0].msaFt).toBe(900)    // peak at 10 NM is outside 5 NM of 0
    expect(m[1].msaFt).toBe(2800)
  })
  it('wider abeam reaches the peak', () => {
    expect(computeMsaProfile(pts, { abeamNm: 10 })[0].msaFt).toBe(2800)
  })
  it('custom vertical clearance', () => {
    expect(computeMsaProfile(pts, { terrainClearanceFt: 500 })[1].msaFt).toBe(2500)
  })
  it('obstacle raises MSA within the corridor only', () => {
    const m = computeMsaProfile(pts, null, [{ distNm: 20, elevationFt: 2650 }])
    expect(m[2].msaFt).toBe(3700)   // 2650 + 1000 = 3650 -> 3700
    expect(m[0].msaFt).toBe(900)
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

describe('computeMsaProfile corridor maximum', () => {
  const pts = [0, 10, 20].map((d) => ({ distNm: d, elevFt: 100 }))
  it('raises MSA from the corridor figure, null entries are ignored', () => {
    const m = computeMsaProfile(pts, null, undefined, [null, 2450, 50])
    expect(m[0].msaFt).toBe(900)    // centreline only
    expect(m[1].msaFt).toBe(3300)   // 2450 + 800 = 3250 -> 3300
    expect(m[2].msaFt).toBe(900)    // corridor lower than centreline: centreline wins
  })
})
