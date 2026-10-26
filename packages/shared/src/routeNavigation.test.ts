import { describe, it, expect } from 'vitest'
import { navigatingLeg, routeDirect, distanceToSegmentNm, shortcutTargetIndex } from './routeNavigation'

// 0.1° lat = 6 NM. A dog-leg route: north, then east, then north again.
const A = { lat: 59.0, lng: 18.0, name: 'A' }
const B = { lat: 59.5, lng: 18.0, name: 'B' }
const C = { lat: 59.5, lng: 19.0, name: 'C' }
const D = { lat: 60.0, lng: 19.0, name: 'D' }
const route = [A, B, C, D]

describe('distanceToSegmentNm', () => {
  it('measures perpendicular distance inside the segment', () => {
    expect(distanceToSegmentNm({ lat: 59.25, lng: 18.0 }, A, B)).toBeCloseTo(0, 5)
    const d = distanceToSegmentNm({ lat: 59.25, lng: 18.1 }, A, B)
    expect(d).toBeGreaterThan(2.9)
    expect(d).toBeLessThan(3.2)
  })
  it('clamps to the ends', () => {
    expect(distanceToSegmentNm({ lat: 58.9, lng: 18.0 }, A, B)).toBeCloseTo(6, 1)
  })
})

describe('navigatingLeg', () => {
  it('is -1 without a route', () => {
    expect(navigatingLeg([A], A)).toBe(-1)
  })
  it('picks the nearest leg', () => {
    expect(navigatingLeg(route, { lat: 59.2, lng: 18.01 })).toBe(0)
    expect(navigatingLeg(route, { lat: 59.49, lng: 18.5 })).toBe(1)
    expect(navigatingLeg(route, { lat: 59.8, lng: 19.02 })).toBe(2)
  })
  it('moves on when a corner is cut, without reaching the turning point', () => {
    // Abeam the corner, 2 NM inside it: closer to the second leg than the first.
    expect(navigatingLeg(route, { lat: 59.49, lng: 18.12 }, 45)).toBe(1)
  })
  it('breaks a tie just before a turning point with the current track', () => {
    const nearB = { lat: 59.4999, lng: 18.0 }
    expect(navigatingLeg(route, nearB, 0)).toBe(0)
    expect(navigatingLeg(route, nearB, 90)).toBe(1)
  })
  it('moves on once the turning point is reached, whatever the track', () => {
    expect(navigatingLeg(route, B, 0)).toBe(1)
    // Direct to a point behind: still on the old track past the new start.
    const P = { lat: 59.2, lng: 18.0 }
    const back = [A, P, { lat: 59.1, lng: 17.5 }]
    expect(navigatingLeg(back, { lat: 59.21, lng: 18.0 }, 0)).toBe(1)
  })
  it('follows the track on a route that doubles back', () => {
    const outAndBack = [A, B, A]
    const mid = { lat: 59.25, lng: 18.0 }
    expect(navigatingLeg(outAndBack, mid, 0)).toBe(0)
    expect(navigatingLeg(outAndBack, mid, 180)).toBe(1)
  })
})

describe('navigatingLeg along a simulated flight', () => {
  // Fly A-B-C-D in 0.2 NM steps, but turn early at B (cut the corner
  // ~1.5 NM inside) and overshoot C by ~1 NM before turning: the active leg
  // must step 0, 1, 2 exactly once each, never skip or go back.
  function fly(path: { lat: number; lng: number }[]): number[] {
    const legs: number[] = []
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k], b = path[k + 1]
      const dLat = (b.lat - a.lat) * 60
      const dLng = (b.lng - a.lng) * 60 * Math.cos((a.lat * Math.PI) / 180)
      const nm = Math.hypot(dLat, dLng)
      const track = ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360
      const steps = Math.max(1, Math.round(nm / 0.2))
      for (let s = 0; s < steps; s++) {
        const p = { lat: a.lat + ((b.lat - a.lat) * s) / steps, lng: a.lng + ((b.lng - a.lng) * s) / steps }
        const leg = navigatingLeg(route, p, track)
        if (legs[legs.length - 1] !== leg) legs.push(leg)
      }
    }
    return legs
  }
  it('follows corner cuts and overshoots in order', () => {
    const path = [
      A,
      { lat: 59.475, lng: 18.0 },   // 1.5 NM short of B, turn early
      { lat: 59.5, lng: 18.06 },    // join leg 1 inside the corner
      { lat: 59.5, lng: 19.03 },    // overshoot C by ~1 NM
      { lat: 59.52, lng: 19.0 },    // turn back onto leg 2
      D,
    ]
    expect(fly(path)).toEqual([0, 1, 2])
  })
})

describe('shortcutTargetIndex', () => {
  it('only matches points ahead of the active leg', () => {
    expect(shortcutTargetIndex(route, 1, C)).toBe(2)
    expect(shortcutTargetIndex(route, 1, A)).toBe(-1)
    expect(shortcutTargetIndex(route, -1, C)).toBe(-1)
  })
})

describe('routeDirect', () => {
  const ovr = [{ altFt: 1500 }, { altFt: 2500 }, { altFt: 3500 }]
  const pos = { lat: 59.2, lng: 18.0 } // on leg 0

  it('starts a new route without one', () => {
    const r = routeDirect({ waypoints: [], legOverrides: [], activeLeg: -1, position: pos, target: D })
    expect(r.kind).toBe('new')
    expect(r.waypoints.map(w => w.name)).toEqual(['Position', 'D'])
    expect(r.activeLeg).toBe(0)
  })

  it('takes a shortcut to a turning point ahead, keeping the rest', () => {
    const r = routeDirect({ waypoints: route, legOverrides: ovr, activeLeg: 0, position: pos, target: { ...C } })
    expect(r.kind).toBe('shortcut')
    expect(r.waypoints.map(w => w.name)).toEqual(['A', 'Position', 'C', 'D'])
    expect(r.legOverrides).toEqual([{ altFt: 1500 }, { altFt: 1500 }, { altFt: 3500 }])
    expect(r.activeLeg).toBe(1)
  })

  it('does not add a zero-length leg when still at the active leg start', () => {
    const r = routeDirect({ waypoints: route, legOverrides: ovr, activeLeg: 0, position: A, target: C })
    expect(r.waypoints.map(w => w.name)).toEqual(['A', 'C', 'D'])
    expect(r.legOverrides).toEqual([{ altFt: 1500 }, { altFt: 3500 }])
    expect(r.activeLeg).toBe(0)
  })

  it('replaces the rest of the route for a destination off the route', () => {
    const X = { lat: 59.3, lng: 17.5, name: 'X' }
    const r = routeDirect({ waypoints: route, legOverrides: ovr, activeLeg: 0, position: pos, target: X })
    expect(r.kind).toBe('direct')
    expect(r.waypoints.map(w => w.name)).toEqual(['A', 'Position', 'X'])
    expect(r.legOverrides.length).toBe(r.waypoints.length - 1)
    expect(r.activeLeg).toBe(1)
  })

  it('diverts via a fix near a leg ahead and rejoins after it', () => {
    const R = { lat: 59.52, lng: 18.5, name: 'R' } // ~1 NM north of leg 1
    const r = routeDirect({ waypoints: route, legOverrides: ovr, activeLeg: 0, position: pos, target: R, rejoin: true })
    expect(r.kind).toBe('divert')
    expect(r.waypoints.map(w => w.name)).toEqual(['A', 'Position', 'R', 'C', 'D'])
    expect(r.legOverrides).toEqual([{ altFt: 1500 }, { altFt: 1500 }, { altFt: 2500 }, { altFt: 3500 }])
    expect(r.activeLeg).toBe(1)
  })

  it('does not rejoin when the fix is far from the route', () => {
    const R = { lat: 59.8, lng: 18.5, name: 'R' }
    const r = routeDirect({ waypoints: route, legOverrides: ovr, activeLeg: 0, position: pos, target: R, rejoin: true })
    expect(r.kind).toBe('direct')
  })
})
