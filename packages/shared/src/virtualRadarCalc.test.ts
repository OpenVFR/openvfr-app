import { describe, it, expect } from 'vitest'

import { plannedAltitudeLine, buildVirtualRadarProfile, DEFAULT_PERF_MODEL } from './virtualRadarCalc'
describe('plannedAltitudeLine on a short route', () => {
  const prof = [
    { distNm: 0, altFt: 1700 }, { distNm: 2.7, altFt: 1700 },
    { distNm: 2.7, altFt: 2000 }, { distNm: 5.43, altFt: 2000 },
    { distNm: 5.43, altFt: 3500 }, { distNm: 7.96, altFt: 3500 },
  ]
  it('keeps the climbs of earlier legs when the final descent does not fit', () => {
    const line = plannedAltitudeLine(prof, 7.96, DEFAULT_PERF_MODEL, 88, 245)
    // Not a straight line from departure to arrival: the early legs climb.
    expect(line.length).toBeGreaterThan(3)
    expect(Math.max(...line.map((p) => p.altFt))).toBeGreaterThan(1500)
    expect(line[0]).toEqual({ distNm: 0, altFt: 88 })
    expect(line[line.length - 1]).toEqual({ distNm: 7.96, altFt: 245 })
  })
  it('is unchanged when the descent fits', () => {
    const long = [{ distNm: 0, altFt: 3500 }, { distNm: 54, altFt: 3500 }]
    const line = plannedAltitudeLine(long, 54, DEFAULT_PERF_MODEL, 20, 20)
    expect(line.some((p) => p.altFt === 3500 && p.distNm > 10 && p.distNm < 45)).toBe(true)
    expect(line[line.length - 1].altFt).toBe(20)
  })
})

describe('the route profile and gliding sectors', () => {
  const square = (name: string, cls: string, type: string) => ({
    type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[[13.4, 55.4], [13.6, 55.4], [13.6, 55.6], [13.4, 55.6], [13.4, 55.4]]] },
    properties: { name, class: cls, type, lower: 'SFC', upper: 'FL060', lower_ft: 0, upper_ft: 6000 },
  })
  const run = (...features: ReturnType<typeof square>[]) => buildVirtualRadarProfile(
    [{ name: 'A', lat: 55.5, lng: 13.3 }, { name: 'B', lat: 55.5, lng: 13.7 }] as never, [],
    { type: 'FeatureCollection', features } as never, { type: 'FeatureCollection', features: [] } as never,
  ).airspaceBands.map(b => b.name)

  it('draws a glider site and a model area, but not a federation\'s gliding sector (a band per sector would swamp the chart)', () => {
    expect(run(square('SITE', 'GLDR', 'GLDR'), square('MODEL', 'MODEL', 'MODEL'), square('SECTOR', 'GLDR', 'GLIDING')).sort()).toEqual(['MODEL', 'SITE'])
    expect(run(square('SECTOR', 'GLDR', 'GLIDING'))).toEqual([])
  })
})
