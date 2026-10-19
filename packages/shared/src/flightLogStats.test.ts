import { describe, it, expect } from 'vitest'
import { computeLogStats, trimParkedTail, formatLogDuration, type LogTrackPoint } from './flightLogStats'

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
