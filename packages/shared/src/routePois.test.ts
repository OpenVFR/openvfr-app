import { describe, it, expect } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { collectRoutePois, poiCorridorNm, poiBaseFt } from './routePois'

const pt = (lng: number, lat: number, properties: Record<string, unknown>) =>
  ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] }, properties })
const fc = (...f: ReturnType<typeof pt>[]): FeatureCollection => ({ type: 'FeatureCollection', features: f })

// A due-east route at 60N: 0.2 deg of longitude is ~6 NM.
const route = [{ lat: 60, lng: 15, name: 'A' }, { lat: 60, lng: 16, name: 'B' }]
const nmLat = (nm: number) => nm / 60

describe('poiCorridorNm', () => {
  it('uses a different distance per kind', () => {
    expect(poiCorridorNm('aerodrome', { towered: true })).toBe(5)
    expect(poiCorridorNm('aerodrome', { towered: false })).toBe(3)
    expect(poiCorridorNm('aerodrome', { type: 'HP' })).toBe(1)
    expect(poiCorridorNm('reporting', {})).toBe(2)
    expect(poiCorridorNm('navaid', {})).toBe(3)
  })
})

describe('collectRoutePois', () => {
  it('applies each kind its own corridor and projects onto the route', () => {
    const aero = fc(
      pt(15.5, 60 + nmLat(4), { icao: 'ESTW', towered: true, type: 'AD', elevation_ft: 120 }),   // 4 NM, towered: in
      pt(15.5, 60 + nmLat(4), { icao: 'ESXX', towered: false, type: 'AD' }),                     // 4 NM, not towered: out
      pt(15.2, 60 + nmLat(2.5), { icao: 'ESNT', towered: false, type: 'AD' }),                   // 2.5 NM: in
    )
    const rp = fc(
      pt(15.4, 60 + nmLat(1.5), { name: 'NORTH', wp_type: 'MRP' }),                              // in
      pt(15.4, 60 + nmLat(2.5), { name: 'FAR', wp_type: 'RP' }),                                 // out
    )
    const pois = collectRoutePois(route, { aerodromes: aero, reporting: rp })
    expect(pois.map((p) => p.label)).toEqual(['ESNT', 'NORTH', 'ESTW'])   // sorted along the route
    const tw = pois.find((p) => p.label === 'ESTW')!
    expect(tw.kind).toBe('aerodrome')
    expect(tw.towered).toBe(true)
    expect(tw.elevationFt).toBe(120)
    expect(tw.distNm).toBeGreaterThan(14)
    expect(tw.lateralNm).toBeCloseTo(4, 0)
  })
  it('drops an aerodrome that is one of the route points', () => {
    const aero = fc(pt(15, 60, { icao: 'A', towered: true }), pt(15.5, 60, { icao: 'ESMID', towered: true }))
    expect(collectRoutePois(route, { aerodromes: aero }).map((p) => p.label)).toEqual(['ESMID'])
  })
  it('needs a route', () => {
    expect(collectRoutePois([route[0]], { aerodromes: fc(pt(15, 60, { icao: 'X' })) })).toEqual([])
  })
})

describe('poiBaseFt', () => {
  it('prefers the surveyed elevation and never goes below sea level', () => {
    const base = { kind: 'aerodrome' as const, distNm: 0, lateralNm: 0, label: '', subtype: '', towered: false }
    expect(poiBaseFt({ ...base, elevationFt: 296 }, 100)).toBe(296)
    expect(poiBaseFt({ ...base, elevationFt: null }, 100)).toBe(100)
    expect(poiBaseFt({ ...base, elevationFt: null }, -20)).toBe(0)
  })
})
