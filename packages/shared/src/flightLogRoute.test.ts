import { describe, it, expect } from 'vitest'
import { canMergeLogs, mergeLogs, mergeCandidates, logRouteJson, parseLogRoute, plannedAltitudesAlongTrack } from './flightLogRoute'
import type { FlightLogDocType } from './types'

const pts = (t0: number, n: number, spd: number, lng0 = 15) =>
  Array.from({ length: n }, (_, i) => ({ lat: 60, lng: lng0 + i * 0.0008, altFt: 1500, spdKts: spd, trkDeg: 90, ts: t0 + i * 1000 }))
const log = (id: string, track: ReturnType<typeof pts>, extra: Partial<FlightLogDocType> = {}): FlightLogDocType => ({
  id, startedAt: track[0].ts, endedAt: track[track.length - 1].ts, aircraftId: 'ac1', registration: 'SE-ABC',
  trackJson: JSON.stringify(track), departureIcao: 'ESSB', arrivalIcao: '', distanceNm: 1, maxAltFt: 1500, updatedAt: 1, ...extra,
})

describe('merging logs broken by a GPS loss', () => {
  const a = log('a', pts(0, 120, 90))
  const b = log('b', pts(120_000 + 5 * 60_000, 120, 90, 15.2), { arrivalIcao: 'ESOW', departureIcao: '' })

  it('merges a continuation: same aircraft, starts within 10 min, already flying', () => {
    expect(canMergeLogs(a, b)).toBe(true)
    expect(mergeCandidates([b, a]).get('a')).toBe('b')
  })

  it('does not merge a new flight, another aircraft, a long gap or the wrong order', () => {
    expect(canMergeLogs(a, log('b2', pts(400_000, 60, 10)))).toBe(false)               // started on the ground
    expect(canMergeLogs(a, { ...b, aircraftId: 'ac2', registration: 'SE-XYZ' })).toBe(false)
    expect(canMergeLogs(a, log('b3', pts(120_000 + 11 * 60_000, 60, 90)))).toBe(false)  // 11 min later
    expect(canMergeLogs(b, a)).toBe(false)
    expect(canMergeLogs(a, { ...b, simulated: true })).toBe(false)
  })

  it('combines the tracks into a new log', () => {
    const m = mergeLogs(a, b, 'ab', 1000)
    expect(m.id).toBe('ab')
    expect(m.startedAt).toBe(a.startedAt)
    expect(m.endedAt).toBe(b.endedAt)
    expect(JSON.parse(m.trackJson)).toHaveLength(240)
    expect(m.departureIcao).toBe('ESSB')
    expect(m.arrivalIcao).toBe('ESOW')
    expect(m.distanceNm).toBeGreaterThan(5)
    expect(m.updatedAt).toBe(1000)
  })
})

describe('route stored with a log', () => {
  const route = { name: 'R', waypoints: [{ lat: 60, lng: 15, name: 'A' }, { lat: 60, lng: 16, name: 'B' }], legOverrides: [{ altFt: 2500 }] }

  it('round-trips and rejects junk', () => {
    expect(parseLogRoute(logRouteJson(route))?.waypoints).toHaveLength(2)
    expect(logRouteJson({ waypoints: [route.waypoints[0]], legOverrides: [] })).toBeUndefined()
    expect(parseLogRoute('nope')).toBeNull()
    expect(parseLogRoute(undefined)).toBeNull()
  })

  it('gives the planned level near the route and nothing far off it', () => {
    const alts = plannedAltitudesAlongTrack(route, [{ lat: 60, lng: 15.5 }, { lat: 60.2, lng: 15.5 }], null)
    expect(alts[0]).toBe(2500)
    expect(alts[1]).toBeNull()   // 12 NM north of the route
  })
})
