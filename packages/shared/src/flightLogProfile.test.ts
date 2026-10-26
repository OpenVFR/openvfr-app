import { describe, it, expect } from 'vitest'
import {
  flightLogProfile, flownAltitudeAt, flownCoordinateAt, flownLineParts, flownPointAt, formatElapsed,
  type FlightLogTrackPoint,
} from './flightLogProfile'

/** Straight east-bound track at 60° N: `n` points one second apart, ~0.025 NM apart. */
function straight(n: number, opts: { lat?: number; alt?: (i: number) => number; t0?: number } = {}): FlightLogTrackPoint[] {
  const lat = opts.lat ?? 60
  return Array.from({ length: n }, (_, i) => ({
    lat, lng: 15 + i * 0.0008, altFt: opts.alt ? opts.alt(i) : 1500, spdKts: 90, ts: (opts.t0 ?? 0) + i * 1000,
  }))
}

describe('flightLogProfile', () => {
  it('returns null without two distinct positions', () => {
    expect(flightLogProfile([])).toBeNull()
    const p = { lat: 60, lng: 15, altFt: 0, spdKts: 0, ts: 0 }
    expect(flightLogProfile([p, { ...p, ts: 1000 }, { ...p, ts: 2000 }])).toBeNull()
  })

  it('simplifies a straight track to its two ends and keeps every point on the axis', () => {
    const prof = flightLogProfile(straight(500))!
    expect(prof.path).toHaveLength(2)
    expect(prof.points).toHaveLength(500)
    expect(prof.points[0].distNm).toBe(0)
    expect(prof.points[499].distNm).toBeCloseTo(prof.totalNm, 9)
    for (let i = 1; i < prof.points.length; i++) expect(prof.points[i].distNm).toBeGreaterThan(prof.points[i - 1].distNm)
    expect(prof.points[10].elapsedMs).toBe(10_000)
    // East-bound with no recorded track: derived from the positions.
    expect(prof.points[10].trkDeg).toBeCloseTo(90, 0)
    expect(prof.points[499].trkDeg).toBeCloseTo(90, 0)
  })

  it('keeps a turn as a vertex', () => {
    const east = straight(200)
    const end = east[east.length - 1]
    const north = Array.from({ length: 200 }, (_, i) => ({ ...end, lat: end.lat + (i + 1) * 0.0004, ts: end.ts + (i + 1) * 1000 }))
    const prof = flightLogProfile([...east, ...north])!
    expect(prof.path).toHaveLength(3)
    expect(prof.path[1]).toMatchObject({ lat: end.lat, lng: end.lng })
  })

  it('caps the number of vertices', () => {
    // Zig-zag: every point is a turn.
    const zig = Array.from({ length: 2000 }, (_, i) => ({ lat: 60 + (i % 2) * 0.01, lng: 15 + i * 0.005, altFt: 1000, spdKts: 90, ts: i * 1000 }))
    const prof = flightLogProfile(zig, { maxVertices: 100 })!
    expect(prof.path.length).toBeLessThanOrEqual(100)
  })

  it('drops parked repeats and marks recording gaps, keeping both ends as vertices', () => {
    const a = straight(100)
    const parked = Array.from({ length: 30 }, (_, i) => ({ ...a[99], ts: a[99].ts + (i + 1) * 1000 }))
    const b = straight(100, { t0: a[99].ts + 120_000 }).map((p) => ({ ...p, lng: p.lng + 0.2 }))
    const prof = flightLogProfile([...a, ...parked, ...b])!
    expect(prof.points).toHaveLength(200)
    expect(prof.points.filter((p) => p.gapBefore)).toHaveLength(1)
    expect(prof.points[100].gapBefore).toBe(true)
    expect(prof.path.some((v) => v.lng === a[99].lng)).toBe(true)
    expect(prof.path.some((v) => v.lng === b[0].lng)).toBe(true)
  })
})

describe('lookups along the flown line', () => {
  const prof = flightLogProfile(straight(101, { alt: (i) => 1000 + i * 10 }))!
  const pts = prof.points

  it('interpolates altitude and position', () => {
    const mid = pts[50].distNm
    expect(flownAltitudeAt(pts, mid)).toBeCloseTo(1500, 6)
    expect(flownAltitudeAt(pts, (pts[50].distNm + pts[51].distNm) / 2)).toBeCloseTo(1505, 6)
    expect(flownAltitudeAt(pts, -5)).toBe(1000)
    expect(flownAltitudeAt(pts, prof.totalNm + 5)).toBe(2000)
    expect(flownCoordinateAt(pts, mid)!.lng).toBeCloseTo(pts[50].lng, 9)
  })

  it('finds the nearest recorded point', () => {
    expect(flownPointAt(pts, pts[30].distNm + 0.001)).toBe(pts[30])
    expect(flownPointAt(pts, pts[31].distNm - 0.001)).toBe(pts[31])
  })

  it('carries the last altitude over points without one', () => {
    const t = straight(10)
    t[5] = { ...t[5], altFt: NaN }
    const p = flightLogProfile(t)!.points
    expect(flownAltitudeAt(p, p[5].distNm)).toBe(1500)
  })
})

describe('flownLineParts', () => {
  it('splits at gaps and at points without altitude', () => {
    const a = straight(20)
    const b = straight(20, { t0: a[19].ts + 60_000 }).map((p) => ({ ...p, lng: p.lng + 0.1 }))
    b[10] = { ...b[10], altFt: NaN }
    const { runs, gaps } = flownLineParts(flightLogProfile([...a, ...b])!.points)
    expect(runs).toHaveLength(3)
    expect(gaps).toHaveLength(2)
  })
})

describe('formatElapsed', () => {
  it('formats', () => {
    expect(formatElapsed(45_000)).toBe('45 s')
    expect(formatElapsed(750_000)).toBe('12 min 30 s')
    expect(formatElapsed(3_912_000)).toBe('1 h 05 min 12 s')
  })
})
