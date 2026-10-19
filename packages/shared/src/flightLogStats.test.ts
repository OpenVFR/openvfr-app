import { describe, it, expect } from 'vitest'
import { computeLogStats, trimParkedTail, formatLogDuration, type LogTrackPoint, type LogStats } from './flightLogStats'

const THR = { takeoffKts: 30, landedKts: 20 }

/** One point per second from t0, speeds given per second. */
function track(t0: number, speeds: number[], alt = 1000): LogTrackPoint[] {
  return speeds.map((spdKts, i) => ({ ts: t0 + i * 1000, spdKts, altFt: alt }))
}
const rep = (v: number, n: number) => Array<number>(n).fill(v)

describe('computeLogStats', () => {
  it('single flight', () => {
    const t = track(0, [...rep(0, 10), ...rep(90, 120), ...rep(0, 20)])
    const s = computeLogStats(t, THR)
    expect(s.flights).toBe(1)
    expect(s.landings).toBe(1)
    expect(s.touchAndGos).toBe(0)
    expect(s.maxGsKts).toBe(90)
    expect(s.airborneMs).toBeGreaterThanOrEqual(119_000)
    expect(s.airborneMs).toBeLessThanOrEqual(121_000)
    expect(s.avgGsKts).toBeGreaterThan(85)
  })

  it('counts touch-and-gos inside one log', () => {
    const circuit = [...rep(80, 60), ...rep(10, 20)] // 20 s slow < 60 s -> T&G
    const t = track(0, [...rep(0, 5), ...circuit, ...circuit, ...rep(80, 60), ...rep(0, 30)])
    const s = computeLogStats(t, THR)
    expect(s.landings).toBe(3)
    expect(s.touchAndGos).toBe(2)
  })

  it('full stop is not a touch-and-go', () => {
    const t = track(0, [...rep(80, 60), ...rep(0, 200), ...rep(80, 60), ...rep(0, 10)])
    const s = computeLogStats(t, THR)
    expect(s.landings).toBe(2)
    expect(s.touchAndGos).toBe(0)
  })

  it('ignores short speed bursts', () => {
    const t = track(0, [...rep(0, 10), ...rep(35, 8), ...rep(0, 10)])
    expect(computeLogStats(t, THR).flights).toBe(0)
  })

  it('detects recording gaps', () => {
    const a = track(0, rep(80, 60))
    const b = track(200_000, rep(80, 60))
    const s = computeLogStats([...a, ...b], THR)
    expect(s.gapCount).toBe(1)
    expect(s.largestGapMs).toBeGreaterThan(100_000)
  })

  it('handles empty track', () => {
    const s = computeLogStats([], THR)
    expect(s.flights).toBe(0)
    expect(s.airborneMs).toBe(0)
  })
})

describe('trimParkedTail', () => {
  it('drops the parked tail but keeps a short ground roll', () => {
    const t = track(0, [...rep(80, 60), ...rep(0, 300)])
    const out = trimParkedTail(t, 20)
    expect(out.length).toBe(60 + 15)
  })

  it('returns same array when nothing to trim', () => {
    const t = track(0, rep(80, 30))
    expect(trimParkedTail(t, 20)).toBe(t)
  })

  it('leaves a never-moving track alone', () => {
    const t = track(0, rep(0, 30))
    expect(trimParkedTail(t, 20)).toBe(t)
  })
})

describe('formatLogDuration', () => {
  it('formats', () => {
    expect(formatLogDuration(20_000)).toBe('<1m')
    expect(formatLogDuration(42 * 60_000)).toBe('42m')
    expect(formatLogDuration(65 * 60_000)).toBe('1h 05m')
  })
})

import { trackToGeoJson, type LogMapPoint } from './flightLogStats'
describe('trackToGeoJson', () => {
  const mk = (t0: number, n: number, lat0: number): LogMapPoint[] =>
    Array.from({ length: n }, (_, i) => ({ ts: t0 + i * 1000, spdKts: 80, altFt: 1000, lat: lat0 + i * 0.001, lng: 18 }))
  it('one solid line when continuous', () => {
    const fc = trackToGeoJson(mk(0, 10, 59))
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].properties.kind).toBe('track')
    expect(fc.features[0].geometry.coordinates).toHaveLength(10)
  })
  it('bridges a gap with a dashed gap feature', () => {
    const fc = trackToGeoJson([...mk(0, 5, 59), ...mk(300_000, 5, 59.1)])
    expect(fc.features.map(f => f.properties.kind)).toEqual(['track', 'gap', 'track'])
    expect(fc.features[1].geometry.coordinates).toEqual([[18, 59.004], [18, 59.1]])
  })
  it('empty/short tracks give no features', () => {
    expect(trackToGeoJson([]).features).toHaveLength(0)
    expect(trackToGeoJson(mk(0, 1, 59)).features).toHaveLength(0)
  })
})

import { logTotals, logPeriodStart } from './flightLogStats'
describe('logTotals / logPeriodStart', () => {
  const st = (airborneMs: number, landings: number) => ({ airborneMs, landings } as LogStats)
  it('sums with fallback to recorded span', () => {
    const t = logTotals([
      { startedAt: 0, endedAt: 1000, distanceNm: 10, stats: st(60_000, 2) },
      { startedAt: 0, endedAt: 5000, distanceNm: 5, stats: st(0, 0) },
      { startedAt: 0, endedAt: 2000, distanceNm: 1, stats: null },
    ])
    expect(t).toEqual({ logs: 3, airborneMs: 67_000, landings: 2, distanceNm: 16 })
  })
  it('period starts', () => {
    const now = Date.UTC(2026, 5, 15)
    expect(logPeriodStart('all', now)).toBe(0)
    expect(logPeriodStart('30d', now)).toBe(now - 30 * 86_400_000)
    expect(new Date(logPeriodStart('year', now)).getMonth()).toBe(0)
  })
})
