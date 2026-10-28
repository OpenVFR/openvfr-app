import { describe, it, expect } from 'vitest'
import { routeNotamAreas } from './preflightNotams'
import { computeWarnings } from './preflightWarnings'
import type { NotamItem } from './fetchNotam'
import type { VirtualRadarProfile } from './virtualRadarCalc'

const wps = [{ lat: 59, lng: 18, name: 'A' }, { lat: 60, lng: 18, name: 'B' }]
const base = { effective: null, expires: null, classification: null, icaoLocation: 'ESAA', polygon: null }

function notam(over: Partial<NotamItem>): NotamItem {
  return {
    id: 'A1/26', nmsId: 'n1', text: 'TEMPORARY RESTRICTED AREA ACT', qCode: 'QRTCA',
    lat: 59.5, lon: 18, radiusNm: 5, icao: { lowerFl: '000', upperFl: '100' } as never,
    ...base, ...over,
  } as NotamItem
}

const profile = (alt: number) => ({
  totalNm: 60, altitudeProfile: [{ distNm: 0, altFt: alt }, { distNm: 60, altFt: alt }],
  maxPlannedAltFt: alt, airspaceBands: [], obstacles: [], landmarks: [], waterCrossings: [], waypointTicks: [],
}) as unknown as VirtualRadarProfile

describe('routeNotamAreas', () => {
  it('finds a circle the route crosses', () => {
    expect(routeNotamAreas({ notams: [notam({})], waypoints: wps })).toHaveLength(1)
  })
  it('ignores a circle off the route', () => {
    expect(routeNotamAreas({ notams: [notam({ lon: 19 })], waypoints: wps })).toEqual([])
  })
  it('ignores NOTAMs that are not restricted-area subjects', () => {
    expect(routeNotamAreas({ notams: [notam({ qCode: 'QMRLC' })], waypoints: wps })).toEqual([])
  })
  it('finds a real polygon', () => {
    const polygon = { type: 'Polygon', coordinates: [[[17.9, 59.4], [18.1, 59.4], [18.1, 59.6], [17.9, 59.6], [17.9, 59.4]]] } as never
    expect(routeNotamAreas({ notams: [notam({ polygon, lat: null, lon: null, radiusNm: null })], waypoints: wps })).toHaveLength(1)
  })
  it('leaves out an area a charted airspace already covers', () => {
    const airspace = { type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { class: 'R', name: 'ESR22 TEST' },
      geometry: { type: 'Polygon', coordinates: [[[17.9, 59.4], [18.1, 59.4], [18.1, 59.6], [17.9, 59.6], [17.9, 59.4]]] },
    }] } as never
    expect(routeNotamAreas({ notams: [notam({ text: 'ESR22 ACTIVE' })], waypoints: wps, airspace })).toEqual([])
  })
})

describe('NOTAM area warning', () => {
  const run = (alt: number, n: NotamItem) =>
    computeWarnings(profile(alt), [], undefined, wps, [], undefined, false, undefined, undefined, { notams: [n] })

  it('warns red when planned level is inside the Q-line range', () => {
    const w = run(3000, notam({}))
    expect(w.map((x) => x.code)).toEqual(['notam-airspace'])
    expect(w[0].level).toBe('danger')
  })
  it('does not warn above the Q-line ceiling', () => {
    expect(run(12000, notam({}))).toEqual([])
  })
  it('treats missing FL limits as unlimited', () => {
    expect(run(15000, notam({ icao: null }))).toHaveLength(1)
  })
})
