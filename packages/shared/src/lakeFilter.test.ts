import { describe, it, expect } from 'vitest'
import { largeLakes, lakeAreaKm2 } from './lakeFilter'

const box = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] })
const f = (geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon, name: string): GeoJSON.Feature => ({ type: 'Feature', properties: { name }, geometry })

describe('largeLakes', () => {
  it('measures area in km2 at the polygon latitude', () => {
    // 0.1 deg x 0.1 deg at 59N: ~11.1 km x ~5.7 km = ~63 km2.
    const a = lakeAreaKm2(box(18, 59, 18.1, 59.1))
    expect(a).toBeGreaterThan(60)
    expect(a).toBeLessThan(66)
  })
  it('keeps the big lakes and drops ponds', () => {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [f(box(14, 58, 14.4, 58.8), 'Big'), f(box(18, 59, 18.01, 59.01), 'Pond')] }
    expect(largeLakes(fc).features.map(x => x.properties?.['name'])).toEqual(['Big'])
  })
  it('subtracts islands (holes)', () => {
    const ring = [[14, 58], [14.4, 58], [14.4, 58.4], [14, 58.4], [14, 58]]
    const hole = [[14.05, 58.05], [14.35, 58.05], [14.35, 58.35], [14.05, 58.35], [14.05, 58.05]]
    const full = lakeAreaKm2({ type: 'Polygon', coordinates: [ring] })
    expect(lakeAreaKm2({ type: 'Polygon', coordinates: [ring, hole] })).toBeLessThan(full * 0.5)
  })
})
