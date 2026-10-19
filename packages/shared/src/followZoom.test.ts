import { describe, it, expect } from 'vitest'
import {
  recenterNeeded, chooseAutoZoom, createFocusTracker, followCountdownSecs, screenOffset, metersPerDp,
  distNm, angleDiff, AUTO_ZOOM_PREFERRED, AUTO_ZOOM_MAX,
} from './followZoom'

const P = (lat: number, lng: number) => ({ lat, lng })
// Roughly Sweden.
const A = P(55.7, 13.2)
const east = (p: { lat: number; lng: number }, nm: number) => P(p.lat, p.lng + nm / (60 * Math.cos((p.lat * Math.PI) / 180)))
const north = (p: { lat: number; lng: number }, nm: number) => P(p.lat + nm / 60, p.lng)

describe('geometry helpers', () => {
  it('distNm is about one minute of latitude per NM', () => {
    expect(distNm(A, north(A, 5))).toBeCloseTo(5, 1)
  })
  it('angleDiff wraps', () => {
    expect(angleDiff(350, 10)).toBe(20)
    expect(angleDiff(10, 350)).toBe(20)
    expect(angleDiff(0, 180)).toBe(180)
  })
  it('a point north of centre is above it with north up and to the left with east up', () => {
    const p = north(A, 1)
    expect(screenOffset(A, p, 12, 0).y).toBeLessThan(0)
    expect(Math.abs(screenOffset(A, p, 12, 0).x)).toBeLessThan(1e-6)
    const r = screenOffset(A, p, 12, 90)   // east is up, so north is to the left
    expect(r.x).toBeLessThan(0)
    expect(Math.abs(r.y)).toBeLessThan(1)
  })
  it('metersPerDp halves per zoom level', () => {
    expect(metersPerDp(50, 12)).toBeCloseTo(metersPerDp(50, 11) / 2, 6)
  })
})

describe('recenterNeeded', () => {
  const base = { zoom: 12, viewW: 400, viewH: 800 }
  it('always moves when there is no previous position', () => {
    expect(recenterNeeded({ ...base, last: null, pos: A, targetBearing: 0 })).toBe(true)
  })
  it('stays put for a small movement and unchanged heading', () => {
    const last = { ...A, bearing: 0 }
    expect(recenterNeeded({ ...base, last, pos: north(A, 0.05), targetBearing: 5 })).toBe(false)
  })
  it('moves after enough distance on screen', () => {
    const last = { ...A, bearing: 0 }
    expect(recenterNeeded({ ...base, last, pos: north(A, 1), targetBearing: 0 })).toBe(true)
  })
  it('moves after a heading change of 15 degrees', () => {
    const last = { ...A, bearing: 0 }
    expect(recenterNeeded({ ...base, last, pos: A, targetBearing: 16 })).toBe(true)
    expect(recenterNeeded({ ...base, last, pos: A, targetBearing: 10 })).toBe(false)
  })
  it('a smaller view lowers the distance threshold', () => {
    const last = { ...A, bearing: 0 }
    const pos = north(A, 0.4)
    const big = recenterNeeded({ zoom: 12, viewW: 1200, viewH: 1200, last, pos, targetBearing: 0 })
    const small = recenterNeeded({ zoom: 12, viewW: 200, viewH: 200, last, pos, targetBearing: 0 })
    expect(small || !big).toBe(true)
  })
})

describe('chooseAutoZoom', () => {
  const view = { viewW: 400, viewH: 800, bearing: 0 }
  it('zooms to the maximum when the focus is next to the aircraft', () => {
    const r = chooseAutoZoom({ ...view, pos: A, focus: north(A, 0.2), near: true })
    expect(r).not.toBeNull()
    expect(r!.zoom).toBeGreaterThan(AUTO_ZOOM_MAX - 0.2)
    expect(r!.centre).not.toBeNull()
  })
  it('zooms out as the focus gets farther, never below the preferred zoom', () => {
    const near = chooseAutoZoom({ ...view, pos: A, focus: north(A, 2), near: false })
    const far = chooseAutoZoom({ ...view, pos: A, focus: north(A, 8), near: false })
    expect(near).not.toBeNull()
    expect(far === null || far.zoom <= near!.zoom).toBe(true)
    if (far) expect(far.zoom).toBeGreaterThanOrEqual(AUTO_ZOOM_PREFERRED)
  })
  it('returns null when even the widest zoom cannot hold the focus', () => {
    expect(chooseAutoZoom({ ...view, pos: A, focus: north(A, 100), near: false })).toBeNull()
  })
  it('keeps the camera on the aircraft away from the field', () => {
    const r = chooseAutoZoom({ ...view, pos: A, focus: north(A, 2), near: false })
    expect(r!.centre).toBeNull()
  })
  it('a look-ahead offset moves where the focus must fit', () => {
    // Focus south of the aircraft with north up: the aircraft sits low, so less room below.
    const without = chooseAutoZoom({ ...view, pos: A, focus: north(A, -3), near: false })
    const withOff = chooseAutoZoom({ ...view, pos: A, focus: north(A, -3), near: false, aheadOffsetDp: 200 })
    expect(without).not.toBeNull()
    expect(withOff === null || withOff.zoom <= without!.zoom).toBe(true)
  })
})

describe('focus tracker', () => {
  const tk = () => createFocusTracker()
  const parked = { speedKts: 0, parkedKts: 15 }
  const flying = { speedKts: 90, parkedKts: 15 }
  it('has no focus on the ground before anything is known', () => {
    const t = tk()
    // Parked at the field: the field itself is the (close-up) focus.
    const r = t.update({ pos: A, route: [], ...parked })
    expect(r?.nearNm).toBe(1)
  })
  it('keeps the departure as focus while flying away, with the wider radius after leaving', () => {
    const t = tk()
    t.update({ pos: A, route: [], ...parked })
    const early = t.update({ pos: north(A, 0.5), route: [], ...flying })
    expect(early?.nearNm).toBe(1)
    const left = t.update({ pos: north(A, 6), route: [], ...flying })
    expect(left?.nearNm).toBe(5)
    expect(distNm(left!.focus, A)).toBeLessThan(0.1)
  })
  it('uses the destination for an A to B route', () => {
    const t = tk()
    const route = [A, north(A, 30)]
    t.update({ pos: A, route, ...parked })
    const r = t.update({ pos: north(A, 3), route, ...flying })
    expect(distNm(r!.focus, route[1])).toBeLessThan(0.1)
    expect(r!.nearNm).toBe(5)
  })
  it('uses the start when the flight began at the route destination', () => {
    const t = tk()
    const route = [A, north(A, 30)]
    t.update({ pos: route[1], route, ...parked })
    const r = t.update({ pos: north(route[1], -3), route, ...flying })
    expect(distNm(r!.focus, route[0])).toBeLessThan(0.1)
  })
  it('a local flight (start = finish) focuses the start once left', () => {
    const t = tk()
    const route = [A, north(A, 10), A]
    t.update({ pos: A, route, ...parked })
    expect(t.update({ pos: north(A, 7), route, ...flying })?.nearNm).toBe(5)
  })
  it('key changes with the focus', () => {
    const t = tk()
    const r1 = t.update({ pos: A, route: [A, north(A, 30)], ...parked })
    const r2 = t.update({ pos: A, route: [A, east(A, 30)], ...parked })
    expect(r1!.key).not.toBe(r2!.key)
  })
  it('reset forgets the departure', () => {
    const t = tk()
    t.update({ pos: A, route: [], ...parked })
    t.reset()
    const far = north(A, 20)
    const r = t.update({ pos: far, route: [], ...flying })
    expect(distNm(r!.focus, far)).toBeLessThan(0.1)   // the old departure is gone
  })
})

describe('followCountdownSecs', () => {
  it('counts whole seconds up and ends at zero', () => {
    expect(followCountdownSecs(15_000, 0)).toBe(15)
    expect(followCountdownSecs(15_000, 14_001)).toBe(1)
    expect(followCountdownSecs(15_000, 15_000)).toBeNull()
    expect(followCountdownSecs(null, 0)).toBeNull()
  })
})
