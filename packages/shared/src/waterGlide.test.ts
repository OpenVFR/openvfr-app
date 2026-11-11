import { describe, it, expect } from 'vitest'
import { waterStretches } from './waterGlide'
import type { MefGrid } from './mefGrid'

// 0.01 x 0.005 deg cells (~0.3 x 0.3 NM at 59.5N). Land west of 19.0E and east of 19.6E, sea (no-data) between.
function grid(): MefGrid {
  const cols = 200, rows = 200, west = 18.5, north = 60
  const codes = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const lng = west + (c + 0.5) * 0.01
    codes[r * cols + c] = lng < 19.0 || lng > 19.6 ? 2 : 255
  }
  return { codes, cols, rows, west, north, cellLon: 0.01, cellLat: 0.005, unitFt: 100 }
}
const across = [{ lat: 59.5, lng: 18.8, name: 'A' }, { lat: 59.5, lng: 19.8, name: 'B' }]

describe('waterStretches', () => {
  it('finds the sea crossing, the furthest point from land and whether a glide reaches land', () => {
    const [s] = waterStretches({ waypoints: across, altAt: () => 2500, grids: [grid()], aircraft: { category: 'SEP', glideRatio: 9 } })
    expect(s!.sea).toBe(true)
    // 0.6 deg of longitude at 59.5N is ~18.3 NM wide: the middle is ~9 NM from either shore.
    expect(s!.maxFromLandNm).toBeGreaterThan(8.5)
    expect(s!.maxFromLandNm).toBeLessThan(9.6)
    expect(s!.glideRangeNm).toBeCloseTo(2500 * 9 / 6076.12, 1)
    expect(s!.beyondGlideNm).toBeGreaterThan(10)
    expect(s!.neededFt).toBeGreaterThan(5500)
    expect(s!.glideAssumed).toBe(false)
  })
  it('is within gliding distance from high enough', () => {
    const [s] = waterStretches({ waypoints: across, altAt: () => 9500, grids: [grid()], aircraft: { category: 'SEP', glideRatio: 9 } })
    expect(s!.beyondGlideNm).toBe(0)
  })
  it('measures a lake to its shore and assumes a glide ratio when the profile has none', () => {
    const lake: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { name: 'Sjön' },
      geometry: { type: 'Polygon', coordinates: [[[18.6, 59.4], [18.95, 59.4], [18.95, 59.6], [18.6, 59.6], [18.6, 59.4]]] },
    }] }
    const r = waterStretches({ waypoints: [{ lat: 59.5, lng: 18.55 }, { lat: 59.5, lng: 18.98 }], altAt: () => 1500, grids: [grid()], water: lake, aircraft: { category: 'SEP' } })
    expect(r).toHaveLength(1)
    expect(r[0]!.name).toBe('Sjön')
    expect(r[0]!.sea).toBe(false)
    expect(r[0]!.glideAssumed).toBe(true)
    expect(r[0]!.glideRatio).toBe(8)
    expect(r[0]!.surfaceFt).toBe(200)
  })
  it('ignores land routes', () => {
    expect(waterStretches({ waypoints: [{ lat: 59.5, lng: 18.6 }, { lat: 59.7, lng: 18.9 }], altAt: () => 2500, grids: [grid()] })).toEqual([])
  })
})
