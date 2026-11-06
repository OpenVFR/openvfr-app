import { describe, it, expect } from 'vitest'
import { gpsTier, isMoving, GPS_REQUESTS, ACTIVE_HOLD_MS, type GpsFixLike } from './gpsPolicy'

const fix = (over: Partial<GpsFixLike> = {}): GpsFixLike => ({ lat: 59, lng: 18, speedKts: 0, accuracyM: 10, tMs: 0, ...over })

describe('gpsTier', () => {
  it('flying is always the flight tier', () => {
    expect(gpsTier({ flying: true, lastMovedAtMs: null, nowMs: 1e9 })).toBe('flight')
  })
  it('stays fast for two minutes after the last movement (or the app opening)', () => {
    expect(gpsTier({ flying: false, lastMovedAtMs: 1000, nowMs: 1000 + ACTIVE_HOLD_MS - 1 })).toBe('ground-active')
  })
  it('drops to idle after that', () => {
    expect(gpsTier({ flying: false, lastMovedAtMs: 1000, nowMs: 1000 + ACTIVE_HOLD_MS })).toBe('ground-idle')
    expect(gpsTier({ flying: false, lastMovedAtMs: null, nowMs: 5 })).toBe('ground-idle')
  })
})

describe('requests', () => {
  it('only the flight tier uses a foreground service', () => {
    expect(GPS_REQUESTS['flight'].foregroundService).toBe(true)
    expect(GPS_REQUESTS['ground-active'].foregroundService).toBe(false)
    expect(GPS_REQUESTS['ground-idle'].foregroundService).toBe(false)
  })
  it('idle asks rarely and for balanced accuracy', () => {
    expect(GPS_REQUESTS['ground-idle'].accuracy).toBe('balanced')
    expect(GPS_REQUESTS['ground-idle'].timeIntervalMs).toBeGreaterThanOrEqual(10_000)
  })
})

describe('isMoving', () => {
  it('uses the fix speed when it has one', () => {
    expect(isMoving(null, fix({ speedKts: 6 }))).toBe(true)
    expect(isMoving(null, fix({ speedKts: 2 }))).toBe(false)
  })
  it('ignores jitter of a stationary balanced fix', () => {
    const a = fix({ accuracyM: 30, tMs: 0 })
    const b = fix({ lat: 59.0004, accuracyM: 35, tMs: 10_000 })   // ~45 m, within 2x accuracy
    expect(isMoving(a, b)).toBe(false)
  })
  it('sees a real displacement without a speed (taxi at ~8 kt)', () => {
    const a = fix({ tMs: 0, accuracyM: 20 })
    const b = fix({ lat: 59.0007, accuracyM: 20, tMs: 10_000 })   // ~78 m in 10 s = ~15 kt
    expect(isMoving(a, b)).toBe(true)
  })
  it('does not count a slow walk across a long gap', () => {
    const a = fix({ tMs: 0, accuracyM: 10 })
    const b = fix({ lat: 59.0009, accuracyM: 10, tMs: 120_000 })  // ~100 m in 2 min = ~1.6 kt
    expect(isMoving(a, b)).toBe(false)
  })
  it('needs time to pass', () => {
    expect(isMoving(fix({ tMs: 5 }), fix({ lat: 59.01, tMs: 5 }))).toBe(false)
  })
})
