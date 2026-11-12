import { describe, it, expect } from 'vitest'
import { projectTrafficMarks, trafficOpacity, type RadarTrafficTarget } from './radarTraffic'

// A 60 NM route due east along latitude 59 (1 deg lng ~ 30.9 NM there).
const route = [{ lat: 59, lng: 17 }, { lat: 59, lng: 19 }]
const totalNm = 61.8
const t = (over: Partial<RadarTrafficTarget>): RadarTrafficTarget => ({
  icao24: 'a', callsign: null, lat: 59, lon: 18, altFt: 3000, trackDeg: 90, vertFpm: 0, onGround: false, ...over,
})

describe('projectTrafficMarks', () => {
  it('places a target on the route by distance along it', () => {
    const [m] = projectTrafficMarks(route, [t({})], totalNm, 5)
    expect(m!.distNm).toBeGreaterThan(30)
    expect(m!.distNm).toBeLessThan(32)
    expect(m!.offRouteNm).toBeLessThan(1) // the route is a great circle, a little north of the parallel
    expect(m!.dir).toBe(1)
  })
  it('keeps only targets inside the corridor', () => {
    const near = t({ icao24: 'n', lat: 59.05 })   // 3 NM north
    const far = t({ icao24: 'f', lat: 59.2 })     // 12 NM north
    const marks = projectTrafficMarks(route, [near, far], totalNm, 5)
    expect(marks.map((m) => m.target.icao24)).toEqual(['n'])
  })
  it('marks opposite-direction traffic and skips ground targets', () => {
    const opp = t({ icao24: 'o', trackDeg: 270 })
    const gnd = t({ icao24: 'g', onGround: true })
    const marks = projectTrafficMarks(route, [opp, gnd], totalNm, 5)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.dir).toBe(-1)
  })
  it('drops targets beyond the ends of the route', () => {
    expect(projectTrafficMarks(route, [t({ lon: 20 })], totalNm, 5)).toHaveLength(0)
  })
})

describe('trafficOpacity', () => {
  it('is 1 near the line and fades toward the corridor edge', () => {
    expect(trafficOpacity(0.5, 5)).toBe(1)
    expect(trafficOpacity(5, 5)).toBeCloseTo(0.45)
    expect(trafficOpacity(3, 5)).toBeLessThan(1)
  })
})
