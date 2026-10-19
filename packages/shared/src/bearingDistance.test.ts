import { describe, it, expect } from 'vitest'
import { parseBearingDistance, pointFromBearingDistance } from './bearingDistance'
import { distanceNm } from './routeCalc'

describe('parseBearingDistance', () => {
  it.each([
    ['EGLL 270 10', 'EGLL', 270, 10],
    ['EGLL/270/10', 'EGLL', 270, 10],
    ['egll r270 d10nm', 'egll', 270, 10],
    ['Place 3 090/4.5', 'Place 3', 90, 4.5],
    ['EGLL 270° 10 NM', 'EGLL', 270, 10],
  ])('%s', (q, ref, b, d) => {
    expect(parseBearingDistance(q)).toEqual({ ref, bearingMag: b, distNm: d })
  })
  it.each(['EGLL', 'Place 3', 'EGLL 400 10', 'EGLL 270 0', '270 10'])('rejects %s', q => {
    expect(parseBearingDistance(q)).toBeNull()
  })
})

describe('pointFromBearingDistance', () => {
  it('lands the requested distance away', () => {
    const from = { lat: 51.47, lng: -0.46 }
    const p = pointFromBearingDistance(from, 270, 10)
    expect(distanceNm(from as never, p as never)).toBeCloseTo(10, 1)
    expect(p.lng).toBeLessThan(from.lng)
  })
})
