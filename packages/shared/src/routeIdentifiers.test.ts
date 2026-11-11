import { describe, it, expect } from 'vitest'
import { buildPointIndex, resolveRoutePoints } from './routeIdentifiers'

const pt = (lng: number, lat: number, properties: Record<string, unknown>) => ({ geometry: { type: 'Point', coordinates: [lng, lat] }, properties })
const idx = buildPointIndex({
  aerodromes: { features: [pt(17.9, 59.3, { icao: 'ESSB', name: 'BROMMA', elevation_ft: 47 }), pt(17.4, 62.5, { icao: 'ESNV', name: 'VILHELMINA' }), pt(14.9, 63.2, { icao: 'ESPE', name: 'VIDSEL' })] },
  navaids: { features: [pt(17.9, 59.6, { id: 'ARL', name: 'ARLANDA' })] },
  waypoints: { features: [pt(17.3, 62.6, { id: 'NORTH', aerodrome: 'ESNV' }), pt(14.8, 63.3, { id: 'NORTH', aerodrome: 'ESPE' }), pt(18.0, 59.4, { id: 'LAVER', aerodrome: 'ESSB' })] },
})

describe('resolveRoutePoints', () => {
  it('resolves aerodromes, navaids, unique reporting points and coordinates', () => {
    const r = resolveRoutePoints(['essb', 'ARL', 'LAVER', '5939N01756E'], idx)
    expect(r.every(x => x.ok)).toBe(true)
    expect(r.map(x => (x.ok ? x.point.name : ''))).toEqual(['ESSB', 'ARL', 'ESSB/LAVER', '59.6500N 17.9333E'])
    expect(r[0]!.ok && r[0]!.point.elevationFt).toBe(47)
  })
  it('picks the copy of a repeated reporting point that belongs to an aerodrome on the route', () => {
    const r = resolveRoutePoints(['NORTH', 'ESNV'], idx)
    expect(r[0]!.ok && r[0]!.point.name).toBe('ESNV/NORTH')
  })
  it('asks for AERODROME/POINT when it cannot tell, and accepts it', () => {
    const r = resolveRoutePoints(['ESSB', 'NORTH'], idx)
    expect(r[1]!.ok).toBe(false)
    expect(!r[1]!.ok && r[1]!.reason).toMatch(/ESNV\/NORTH, ESPE\/NORTH/)
    expect(resolveRoutePoints(['ESPE/NORTH'], idx)[0]!.ok).toBe(true)
  })
  it('refuses unknown names', () => {
    const r = resolveRoutePoints(['XXXX'], idx)
    expect(r[0]!.ok).toBe(false)
  })
})
