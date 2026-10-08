import { describe, it, expect, vi, afterEach } from 'vitest'
import { windLattice, fetchWindGrid, cachedWindGrid, windOverlayAltitude } from './windGrid'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
const bounds = (w: number, s: number, e: number, n: number) => ({ west: w, south: s, east: e, north: n })

describe('windLattice', () => {
  it('keeps at most N points per side', () => {
    for (const b of [bounds(10, 55, 25, 65), bounds(17.5, 59.2, 18.5, 59.6), bounds(-170, -60, 170, 70)]) {
      const pts = windLattice(b, 6)
      expect(pts.length).toBeGreaterThan(0)
      expect(pts.length).toBeLessThanOrEqual(36)
    }
  })
  it('is anchored to the world: a small pan reuses the same points', () => {
    const a = windLattice(bounds(14, 56, 20, 62), 5)
    const b = windLattice(bounds(14.3, 56.2, 20.3, 62.2), 5)
    const keys = new Set(a.map((p) => `${p.lat},${p.lng}`))
    const shared = b.filter((p) => keys.has(`${p.lat},${p.lng}`))
    expect(shared.length).toBeGreaterThanOrEqual(Math.floor(b.length * 0.6))
  })
  it('only lies inside the viewport', () => {
    const b = bounds(14, 56, 20, 62)
    for (const p of windLattice(b, 6)) {
      expect(p.lat).toBeGreaterThanOrEqual(b.south); expect(p.lat).toBeLessThanOrEqual(b.north)
      expect(p.lng).toBeGreaterThanOrEqual(b.west);  expect(p.lng).toBeLessThanOrEqual(b.east)
    }
  })
  it('zooming in gives a finer lattice (smaller step)', () => {
    const step = (pts: { lat: number }[]) => { const l = [...new Set(pts.map((p) => p.lat))].sort((x, y) => x - y); return l.length > 1 ? l[1] - l[0] : Infinity }
    expect(step(windLattice(bounds(17.9, 59.3, 18.2, 59.5), 5))).toBeLessThan(step(windLattice(bounds(10, 55, 25, 65), 5)))
  })
})

describe('windOverlayAltitude', () => {
  it('uses live altitude while airborne', () => {
    expect(windOverlayAltitude(2340, 5000)).toEqual({ altFt: 2500, label: 'WIND 2,300 ft' })
  })
  it('uses planned altitude when not flying', () => {
    expect(windOverlayAltitude(null, 4500)).toEqual({ altFt: 4500, label: 'WIND 4,500 ft PLAN' })
  })
  it('falls back to surface: no plan, or low live altitude', () => {
    expect(windOverlayAltitude(null, null)).toEqual({ altFt: null, label: 'WIND SFC' })
    expect(windOverlayAltitude(300, 5000)).toEqual({ altFt: null, label: 'WIND SFC' })
  })
})

describe('fetchWindGrid', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches all missing points in ONE request and caches them', async () => {
    const b = bounds(31, 41, 36, 46)   // far from other tests' cache keys
    const pts = windLattice(b, 3)
    const f = vi.fn(async () => ok(pts.map(() => ({ current: { wind_speed_10m: 8, wind_direction_10m: 200 } }))))
    vi.stubGlobal('fetch', f)
    const res = await fetchWindGrid(b, null, { gridSize: 3 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(res).toHaveLength(pts.length)
    expect(res[0]).toMatchObject({ dirDeg: 200, speedKts: 8 })
    // second call: everything cached, no network
    await fetchWindGrid(b, null, { gridSize: 3 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(cachedWindGrid(b, null, { gridSize: 3 })).toHaveLength(pts.length)
  })
  it('drops points the model returned nothing for, keeps the rest', async () => {
    const b = bounds(41, 11, 46, 16)
    const pts = windLattice(b, 3)
    vi.stubGlobal('fetch', vi.fn(async () => ok(pts.map((_, i) => ({ current: i === 0 ? {} : { wind_speed_10m: 5, wind_direction_10m: 90 } })))))
    const res = await fetchWindGrid(b, null, { gridSize: 3 })
    expect(res).toHaveLength(pts.length - 1)
  })
  it('a failed request yields an empty (not throwing) grid', async () => {
    const b = bounds(51, 21, 56, 26)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }) as unknown as Response))
    expect(await fetchWindGrid(b, null, { gridSize: 3 })).toEqual([])
  })
})
