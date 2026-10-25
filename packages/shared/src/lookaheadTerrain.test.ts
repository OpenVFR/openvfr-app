import { describe, it, expect, vi, afterEach } from 'vitest'
import { carryLookaheadTerrain } from './lookaheadTerrain'
import { advancePosition } from './routeCalc'
import { fetchTerrainProfile } from './virtualRadarCalc'
import type { ElevationLookup } from './terrainDem'

const route = (lat: number, lng: number, trk: number, nm = 30) => {
  const end = advancePosition(lat, lng, trk, nm)
  return [{ lat, lng, name: 'Position' }, { lat: end.lat, lng: end.lng, name: 'end' }]
}
const pts = Array.from({ length: 31 }, (_, i) => ({ distNm: i, elevFt: i * 100 }))

describe('carryLookaheadTerrain', () => {
  const prev = route(59.5, 17.0, 90)

  it('shifts the samples by the distance flown along the same track', () => {
    const p = advancePosition(59.5, 17.0, 90, 2)
    const out = carryLookaheadTerrain(prev, pts, route(p.lat, p.lng, 90))!
    expect(out).not.toBeNull()
    expect(out[0].distNm).toBe(0)
    expect(out[0].elevFt).toBeCloseTo(200, -1)   // the old 2 NM ground is now under the aircraft
    expect(out[out.length - 1].distNm).toBeCloseTo(28, 1)
    expect(out.length).toBeGreaterThanOrEqual(28)
  })

  it('same position (time-based refresh): unchanged', () => {
    expect(carryLookaheadTerrain(prev, pts, route(59.5, 17.0, 90.5))).toEqual(pts)
  })

  it('a turn drops it', () => {
    const p = advancePosition(59.5, 17.0, 90, 1)
    expect(carryLookaheadTerrain(prev, pts, route(p.lat, p.lng, 100))).toBeNull()
  })

  it('off the old line or behind its start drops it', () => {
    const side = advancePosition(59.5, 17.0, 0, 1)
    expect(carryLookaheadTerrain(prev, pts, route(side.lat, side.lng, 90))).toBeNull()
    const back = advancePosition(59.5, 17.0, 270, 1)
    expect(carryLookaheadTerrain(prev, pts, route(back.lat, back.lng, 90))).toBeNull()
  })

  it('only two-point routes, with something left to show', () => {
    expect(carryLookaheadTerrain([...prev, prev[1]], pts, prev)).toBeNull()
    const far = advancePosition(59.5, 17.0, 90, 29.5)
    expect(carryLookaheadTerrain(prev, pts, route(far.lat, far.lng, 90))).toBeNull()
  })
})

describe('fetchTerrainProfile preferLookup', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const dem = (ft: number | null): ElevationLookup => ({ elevationFt: async () => ft })
  const api = () => {
    const fn = vi.fn(async (u: string) => {
      const n = new URL(u, 'http://x').searchParams.get('locations')!.split('|').length
      return new Response(JSON.stringify({ status: 'OK', results: Array.from({ length: n }, () => ({ elevation: 10 })) }), { status: 200 })
    })
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
  }
  const r = route(59.5, 17.0, 90, 5)

  it('DEM first: no API call when it covers the route', async () => {
    const f = api()
    const out = await fetchTerrainProfile(r, '', undefined, dem(500), { preferLookup: true })
    expect(out.every((p) => p.elevFt === 500)).toBe(true)
    expect(f).not.toHaveBeenCalled()
  })

  it('DEM without coverage: API', async () => {
    const f = api()
    const out = await fetchTerrainProfile(r, '', undefined, dem(null), { preferLookup: true })
    expect(f).toHaveBeenCalledTimes(1)
    expect(out[0].elevFt).toBe(Math.round(10 * 3.28084))
  })

  it('DEM covering only part of the route: API, not carried-flat DEM values', async () => {
    const f = api()
    let n = 0
    const partial: ElevationLookup = { elevationFt: async () => (n++ < 3 ? 500 : null) }
    const out = await fetchTerrainProfile(r, '', undefined, partial, { preferLookup: true })
    expect(f).toHaveBeenCalledTimes(1)
    expect(out.every((p) => p.elevFt === Math.round(10 * 3.28084))).toBe(true)
  })

  it('default: API first', async () => {
    const f = api()
    await fetchTerrainProfile(r, '', undefined, dem(500))
    expect(f).toHaveBeenCalledTimes(1)
  })
})
