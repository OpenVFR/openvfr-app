import { describe, it, expect } from 'vitest'
import { buildPointIndex, resolveRoutePoints } from './routeIdentifiers'
import { allPoints, pointsNearPosition, pointsNearLeg, pointsNearAirspaceEdge } from './pointsNear'

const pt = (lng: number, lat: number, properties: Record<string, unknown>) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] }, properties })
const idx = buildPointIndex({
  aerodromes: { features: [pt(17.0, 59.0, { icao: 'ESAA', name: 'ALPHA' }), pt(18.0, 59.0, { icao: 'ESBB', name: 'BRAVO' })] },
  navaids: { features: [pt(17.5, 59.05, { id: 'NAV', name: 'NAVAID' })] },
  waypoints: { features: [pt(17.3, 58.95, { id: 'SIERRA', aerodrome: 'ESAA' })] },
  landmarks: { features: [pt(17.6, 59.2, { kind: 'church', name: 'Byns kyrka' }), pt(17.7, 59.3, { kind: 'mast', name: '' })] },
})
// A TMA box over the middle of the leg, floor 1,500 ft.
const tma: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [{
  type: 'Feature', properties: { class: 'C', name: 'TEST TMA', lower_ft: 1500, upper_ft: 9500 },
  geometry: { type: 'Polygon', coordinates: [[[17.4, 58.9], [17.65, 58.9], [17.65, 59.1], [17.4, 59.1], [17.4, 58.9]]] },
}] }
const all = allPoints(idx)

describe('route identifiers for landmarks', () => {
  it('resolves a named landmark, unnamed ones are not points', () => {
    const r = resolveRoutePoints(['LM/Byns kyrka'], idx)
    expect(r[0]!.ok && r[0]!.point.name).toBe('Byns kyrka')
    expect(all.some(p => p.kind === 'landmark' && !p.id)).toBe(false)
  })
})

describe('pointsNear', () => {
  it('near a position, nearest first, with the airspace above', () => {
    const r = pointsNearPosition(all, { lat: 59.05, lng: 17.5 }, 10, { airspace: tma })
    expect(r[0]!.identifier).toBe('NAV')
    expect(r[0]!.controlledAbove).toEqual({ name: 'TEST TMA', cls: 'C', floorFt: 1500 })
  })
  it('along a leg, with side and distance along', () => {
    const r = pointsNearLeg(all, { lat: 59, lng: 17, name: 'ESAA' }, { lat: 59, lng: 18, name: 'ESBB' }, 12, { kinds: ['landmark', 'waypoint'] })
    const church = r.find(p => p.identifier === 'LM/Byns kyrka')!
    expect(church.side).toBe('left')
    expect(church.alongNm).toBeGreaterThan(15)
    expect(r.find(p => p.identifier === 'ESAA/SIERRA')!.side).toBe('right')
  })
  it('just outside an airspace edge', () => {
    const r = pointsNearAirspaceEdge(all, tma, 'test tma', 10)
    expect(r.matched).toEqual(['TEST TMA'])
    expect(r.points.map(p => p.identifier)).toContain('ESAA/SIERRA')
    expect(r.points.map(p => p.identifier)).not.toContain('NAV')
    expect(r.points.every(p => (p.edgeNm ?? 0) > 0)).toBe(true)
  })
})
