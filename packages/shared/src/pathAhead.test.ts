import { describe, it, expect } from 'vitest'
import { pathAhead, nextPathAhead, pathAheadLegOverrides, plannedLineEnds, AHEAD_MIN_NM } from './pathAhead'
import { distanceNm, advancePosition } from './routeCalc'
import { distanceAlongRouteNm } from './virtualRadarCalc'

// A dog-leg: 20 NM east, then 20 NM north.
const A = { lat: 55.5, lng: 13.0, name: 'A' }
const B = { ...advancePosition(A.lat, A.lng, 90, 20), name: 'B' }
const C = { ...advancePosition(B.lat, B.lng, 0, 20), name: 'C' }
const route = [A, B, C]
const totalLen = (wps: { lat: number; lng: number }[]) => wps.slice(1).reduce((s, w, i) => s + distanceNm(wps[i] as never, w as never), 0)

describe('pathAhead', () => {
  it('on the route: follows it round the turn, aircraft just after the start', () => {
    const at = advancePosition(A.lat, A.lng, 90, 15)   // 5 NM before B, on the line
    const p = pathAhead(route, { ...at, trackDeg: 90, speedKts: 100 }, false)
    expect(p.onRoute).toBe(true)
    // 12 min at 100 kt = 20 NM ahead, 1 NM behind; turns at B.
    expect(p.waypoints.map(w => w.name)).toEqual(['', 'B', ''])
    expect(totalLen(p.waypoints)).toBeCloseTo(21, 1)
    expect(p.routeLegOf).toEqual([0, 1])
    expect(distanceAlongRouteNm(p.waypoints, at)).toBeCloseTo(1, 1)
  })
  it('off the route: straight along the track, at least AHEAD_MIN_NM', () => {
    const far = advancePosition(A.lat, A.lng, 180, 10)
    const p = pathAhead(route, { ...far, trackDeg: 270, speedKts: 30 }, true)
    expect(p.onRoute).toBe(false)
    expect(p.waypoints).toHaveLength(2)
    expect(totalLen(p.waypoints)).toBeCloseTo(AHEAD_MIN_NM + 1, 1)
    expect(p.routeLegOf).toEqual([-1])
  })
  it('hysteresis: 1.5 NM off joins only from on-route', () => {
    const side = advancePosition(...(Object.values(advancePosition(A.lat, A.lng, 90, 10)) as [number, number]), 0, 1.5)
    const pos = { ...side, trackDeg: 90, speedKts: 90 }
    expect(pathAhead(route, pos, false).onRoute).toBe(false)
    expect(pathAhead(route, pos, true).onRoute).toBe(true)
  })
  it('ends at the destination; past it, straight', () => {
    const near = advancePosition(B.lat, B.lng, 0, 15)   // 5 NM before C
    const p = pathAhead(route, { ...near, trackDeg: 0, speedKts: 100 }, true)
    expect(p.waypoints[p.waypoints.length - 1]).toBe(C)
    const past = advancePosition(C.lat, C.lng, 0, 0.5)
    expect(pathAhead(route, { ...past, trackDeg: 0, speedKts: 100 }, true).onRoute).toBe(false)
  })
  it('no route: straight', () => {
    expect(pathAhead([], { lat: 55, lng: 13, trackDeg: 45, speedKts: 90 }, false).onRoute).toBe(false)
  })
})

describe('nextPathAhead', () => {
  const pos = { ...advancePosition(A.lat, A.lng, 90, 5), trackDeg: 90, speedKts: 90 }
  it('keeps the path for small moves, rebuilds after REBUILD_MOVE_NM or a route change', () => {
    const s1 = nextPathAhead(null, route, pos, 0)
    const small = { ...advancePosition(pos.lat, pos.lng, 90, 0.2), trackDeg: 90, speedKts: 90 }
    expect(nextPathAhead(s1, route, small, 1000)).toBe(s1)
    const big = { ...advancePosition(pos.lat, pos.lng, 90, 0.6), trackDeg: 90, speedKts: 90 }
    expect(nextPathAhead(s1, route, big, 1000)).not.toBe(s1)
    expect(nextPathAhead(s1, [...route], small, 1000)).not.toBe(s1)
  })
  it('straight path rebuilds on a track change; leaving the route rebuilds at once', () => {
    const off = { lat: 55.0, lng: 13.0, trackDeg: 0, speedKts: 90 }
    const s1 = nextPathAhead(null, route, off, 0)
    expect(nextPathAhead(s1, route, { ...off, trackDeg: 8 }, 1000)).not.toBe(s1)
    const on = nextPathAhead(null, route, pos, 0)
    const veered = { ...advancePosition(pos.lat, pos.lng, 180, 0.4), trackDeg: 180, speedKts: 90 }
    // 0.4 NM: below the move threshold, but still on the route: kept.
    expect(nextPathAhead(on, route, veered, 1000)).toBe(on)
  })
})

describe('pathAheadLegOverrides / plannedLineEnds', () => {
  it('route legs take their own level, the rest the current one', () => {
    expect(pathAheadLegOverrides({ waypoints: [], onRoute: true, routeLegOf: [0, 1, -1], trackDeg: 0 }, ['L0', 'L1'], 'HERE'))
      .toEqual(['L0', 'L1', 'HERE'])
    // A route leg without its own level stays without (the chart's default level), not the current altitude.
    expect(pathAheadLegOverrides({ waypoints: [], onRoute: true, routeLegOf: [2], trackDeg: 0 }, ['L0', 'L1'], 'HERE'))
      .toEqual([undefined])
  })
  it('an airborne start or end uses the planned level, not the ground', () => {
    const prof = [{ altFt: 2500 }, { altFt: 3500 }]
    expect(plannedLineEnds(100, 50, prof, undefined)).toEqual({ startFt: 100, endFt: 50 })
    expect(plannedLineEnds(100, 50, prof, { start: true, end: false })).toEqual({ startFt: 2500, endFt: 50 })
    expect(plannedLineEnds(100, 50, prof, { start: true, end: true })).toEqual({ startFt: 2500, endFt: 3500 })
  })
})
