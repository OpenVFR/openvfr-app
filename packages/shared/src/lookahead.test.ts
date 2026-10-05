import { describe, it, expect } from 'vitest'
import { lookaheadPath, accuracyRing, LOOKAHEAD_SAMPLES, ACCURACY_MAX_M } from './lookahead'
import { distanceNm, bearingDeg } from './routeCalc'

const o = { lat: 59.0, lng: 18.0 }

describe('lookaheadPath', () => {
  const pts = lookaheadPath(o.lat, o.lng, 90, 10)
  it('on-track samples plus fan', () => expect(pts).toHaveLength(LOOKAHEAD_SAMPLES + 4))
  it('last on-track sample at full distance on track', () => {
    const p = pts[LOOKAHEAD_SAMPLES - 1]
    expect(distanceNm(o, p)).toBeCloseTo(10, 1)
    expect(bearingDeg(o, p)).toBeCloseTo(90, 0)
  })
  it('fan points 15 deg either side', () => {
    const brgs = pts.slice(LOOKAHEAD_SAMPLES).map(p => Math.round(bearingDeg(o, p)))
    expect(brgs.sort((a, b) => a - b)).toEqual([75, 75, 105, 105])
  })
  it('wraps bearing through north', () => {
    const p = lookaheadPath(o.lat, o.lng, 5, 10)
    expect(p.every(q => Number.isFinite(q.lat) && Number.isFinite(q.lng))).toBe(true)
  })
})

describe('accuracyRing', () => {
  it('empty for good fixes', () => { expect(accuracyRing(o.lat, o.lng, 0)).toEqual([]); expect(accuracyRing(o.lat, o.lng, 20)).toEqual([]) })
  it('4 points at the accuracy radius', () => {
    const r = accuracyRing(o.lat, o.lng, 185.2)
    expect(r).toHaveLength(4)
    for (const p of r) expect(distanceNm(o, p)).toBeCloseTo(0.1, 2)
  })
  it('clamped', () => {
    const r = accuracyRing(o.lat, o.lng, 5000)
    for (const p of r) expect(distanceNm(o, p)).toBeCloseTo(ACCURACY_MAX_M / 1852, 2)
  })
})
