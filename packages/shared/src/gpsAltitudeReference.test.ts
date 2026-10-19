import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  classifyOffsets, initGpsAltitudeReference, gpsAltitudeReference, gpsAltitudeReferenceStatus,
  observeGroundSample, __resetGpsAltitudeReferenceForTests, type GroundSample,
} from './gpsAltitudeReference'

// Arlanda: EGM96 geoid ~23.2 m.
const ARLANDA = { lat: 59.652, lng: 17.919 }
const GROUND_M = 41

function memStore() {
  const m = new Map<string, string>()
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}

/** n stationary fixes, 6 s apart, raw = ground + offset + deterministic noise. */
function feed(n: number, offsetM: number, extra: Partial<GroundSample> = {}, t0 = 1_000_000) {
  for (let i = 0; i < n; i++) {
    const noise = ((i * 7919) % 11) - 5   // -5..+5 m
    observeGroundSample({ ...ARLANDA, rawAltM: GROUND_M + offsetM + noise, groundElevM: GROUND_M, speedKts: 0, altAccuracyM: 6, t: t0 + i * 6000, ...extra })
  }
}

beforeEach(() => __resetGpsAltitudeReferenceForTests())

describe('classifyOffsets', () => {
  const around = (c: number) => Array.from({ length: 20 }, (_, i) => c + ((i % 5) - 2) * 2)
  it('tells ellipsoidal from sea-level heights', () => {
    expect(classifyOffsets(around(23), 23).ref).toBe('ellipsoid')
    expect(classifyOffsets(around(0), 23).ref).toBe('msl')
  })
  it('stays undecided in between, with too few samples, or where the geoid is small', () => {
    expect(classifyOffsets(around(11.5), 23).ref).toBeNull()
    expect(classifyOffsets(around(23).slice(0, 10), 23).ref).toBeNull()
    expect(classifyOffsets(around(0), 6).ref).toBeNull()
  })
})

describe('ground check', () => {
  it('keeps the platform default until verified, then confirms it quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memStore()
    await initGpsAltitudeReference({ platformDefault: 'ellipsoid', environment: 'android 34 app 1.0', store })
    expect(gpsAltitudeReferenceStatus().source).toBe('platform-default')
    feed(25, 23)
    expect(gpsAltitudeReference()).toBe('ellipsoid')
    expect(gpsAltitudeReferenceStatus().source).toBe('verified')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('switches to the measured reference (and warns) when the platform changed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memStore()
    await initGpsAltitudeReference({ platformDefault: 'ellipsoid', environment: 'android 36 app 2.0', store })
    feed(25, 0)   // the device already reports sea level
    expect(gpsAltitudeReference()).toBe('msl')
    expect(warn).toHaveBeenCalledOnce()
    // Persisted for this environment...
    __resetGpsAltitudeReferenceForTests()
    await initGpsAltitudeReference({ platformDefault: 'ellipsoid', environment: 'android 36 app 2.0', store })
    expect(gpsAltitudeReference()).toBe('msl')
    // ...and re-checked when the environment changes.
    __resetGpsAltitudeReferenceForTests()
    await initGpsAltitudeReference({ platformDefault: 'ellipsoid', environment: 'android 37 app 2.1', store })
    expect(gpsAltitudeReference()).toBe('ellipsoid')
    warn.mockRestore()
  })

  it('ignores moving, inaccurate and too-frequent fixes', async () => {
    await initGpsAltitudeReference({ platformDefault: 'ellipsoid', environment: 'x' })
    feed(30, 0, { speedKts: 40 })
    feed(30, 0, { altAccuracyM: 30 }, 5_000_000)
    for (let i = 0; i < 30; i++) observeGroundSample({ ...ARLANDA, rawAltM: GROUND_M, groundElevM: GROUND_M, speedKts: 0, t: 9_000_000 + i * 1000 })
    expect(gpsAltitudeReferenceStatus().source).toBe('platform-default')
    expect(gpsAltitudeReferenceStatus().pendingSamples).toBeLessThan(20)
  })

  it('does not decide where the geoid height is unknown or small', async () => {
    await initGpsAltitudeReference({ platformDefault: 'ellipsoid', environment: 'x' })
    feed(30, 0, { lat: 80, lng: 15 })
    expect(gpsAltitudeReferenceStatus().source).toBe('platform-default')
  })
})
