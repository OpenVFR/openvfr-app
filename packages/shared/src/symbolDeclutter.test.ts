import { describe, it, expect } from 'vitest'
import type { FeatureCollection, Point } from 'geojson'
import { displaceReportingPoints, displaceWaypoints, landmarkRadius, placeMarks, reportingRadius, restore, sameDisplacement, toLonLat, toScreen, waypointBlockers, type View } from './symbolDeclutter'

const view = (over: Partial<View> = {}): View => ({ lon: 13.02, lat: 55.425, zoom: 16, bearing: 0, width: 800, height: 600, ...over })

describe('screen maths', () => {
  it('the centre is the middle of the screen and it round-trips, also with a bearing', () => {
    for (const v of [view(), view({ bearing: 37 }), view({ zoom: 12, bearing: -120 })]) {
      const [x, y] = toScreen(v.lon, v.lat, v)
      expect([Math.round(x), Math.round(y)]).toEqual([400, 300])
      const [lon, lat] = toLonLat(512, 123, v)
      const [x2, y2] = toScreen(lon, lat, v)
      expect(x2).toBeCloseTo(512, 3); expect(y2).toBeCloseTo(123, 3)
    }
  })
  it('north is up without a bearing, and the bearing direction is up with one', () => {
    const v = view()
    expect(toScreen(v.lon, v.lat + 0.001, v)[1]).toBeLessThan(300)
    const rot = view({ bearing: 90 })                 // facing east: east is up
    expect(toScreen(rot.lon + 0.001, rot.lat, rot)[1]).toBeLessThan(300)
  })
})

describe('placing marks', () => {
  it('a mark that collides with nothing stays', () => {
    expect(placeMarks([{ id: 'a', x: 100, y: 100, r: 10 }], [{ x: 300, y: 300, r: 10 }]).size).toBe(0)
  })
  it('a mark on a symbol moves beside it, clear of it, and a second mark does not land on the first', () => {
    const blockers = [{ x: 100, y: 100, r: 12 }]
    const got = placeMarks([{ id: 'a', x: 100, y: 100, r: 10 }, { id: 'b', x: 101, y: 100, r: 10 }], blockers)
    for (const id of ['a', 'b']) {
      const d = got.get(id)!
      const m = id === 'a' ? [100, 100] : [101, 100]
      expect(Math.hypot(m[0] + d[0] - 100, m[1] + d[1] - 100)).toBeGreaterThanOrEqual(12 + 10)
    }
    const a = got.get('a') ?? [0, 0], b = got.get('b') ?? [0, 0]
    expect(Math.hypot(100 + a[0] - (101 + b[0]), 100 + a[1] - (100 + b[1]))).toBeGreaterThanOrEqual(20)
  })
  it('goes around a crowd: all four sides taken, it still finds a spot', () => {
    const blockers = [{ x: 100, y: 100, r: 12 }, { x: 128, y: 100, r: 12 }, { x: 72, y: 100, r: 12 }, { x: 100, y: 72, r: 12 }, { x: 100, y: 128, r: 12 }]
    const d = placeMarks([{ id: 'a', x: 100, y: 100, r: 10 }], blockers).get('a')
    expect(d).toBeDefined()
    for (const b of blockers) expect(Math.hypot(100 + d![0] - b.x, 100 + d![1] - b.y)).toBeGreaterThanOrEqual(b.r + 10)
  })
})

describe('displacing reporting points', () => {
  const v = view()
  const fc = (): FeatureCollection => ({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] }, properties: { kind: 'reporting_point', aerodrome: 'ESTT', name: 'Rängs kyrka', label: 'Rängs kyrka' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon + 0.05, v.lat] }, properties: { kind: 'reporting_point', aerodrome: 'ESTT', name: 'Far away' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { kind: 'circuit_leg' } },
  ] })
  const church = { lon: v.lon, lat: v.lat, r: landmarkRadius(v.zoom) }

  it('a point on a landmark moves beside it, keeps its true place in lon0/lat0 and other features are untouched', () => {
    const out = displaceReportingPoints(fc(), [church], v)
    const p = out.features[0] as unknown as { geometry: Point; properties: Record<string, unknown> }
    const [x, y] = toScreen(p.geometry.coordinates[0], p.geometry.coordinates[1], v)
    expect(Math.hypot(x - 400, y - 300)).toBeGreaterThanOrEqual(landmarkRadius(v.zoom) + reportingRadius(v.zoom))
    expect(p.properties['displaced']).toBe(true)
    expect([p.properties['lon0'], p.properties['lat0']]).toEqual([v.lon, v.lat])
    expect(out.features[1]).toEqual(fc().features[1])
    expect(out.features[2]).toEqual(fc().features[2])
  })
  it('nothing near: unchanged; a pitched view: unchanged; restoring and re-displacing is stable', () => {
    expect(displaceReportingPoints(fc(), [], v)).toEqual(fc())
    expect(displaceReportingPoints(fc(), [church], view({ pitch: 40 }))).toEqual(fc())
    const once = displaceReportingPoints(fc(), [church], v)
    const twice = displaceReportingPoints(once, [church], v)
    expect(sameDisplacement(once, twice)).toBe(true)
    expect(restore(once)).toEqual(fc())
    const elsewhere = displaceReportingPoints(once, [], v)                      // the landmark is gone from the view: the point goes home
    expect(elsewhere).toEqual(fc())
  })
})

describe('mandatory reporting points stay put, VFR reporting points make room', () => {
  const v = view()
  const wp = (name: string, type: string, dx = 0): never => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon + dx, v.lat] },
    properties: { name, wp_type: type, aerodrome: 'ESXX' } }) as never
  const church = { lon: v.lon, lat: v.lat, r: landmarkRadius(v.zoom) }
  const fc = (...f: unknown[]): FeatureCollection => ({ type: 'FeatureCollection', features: f as never[] })

  it('a mandatory reporting point on a landmark is not moved, a VFR one is', () => {
    const out = displaceWaypoints(fc(wp('NORTH', 'MRP'), wp('KVARN', 'RP', 0.00001)), [church], v)
    expect(out.features[0]).toEqual(fc(wp('NORTH', 'MRP')).features[0])
    const rp = out.features[1] as unknown as { geometry: Point; properties: Record<string, unknown> }
    expect(rp.properties['displaced']).toBe(true)
    const [x, y] = toScreen(rp.geometry.coordinates[0], rp.geometry.coordinates[1], v)
    expect(Math.hypot(x - 400, y - 300)).toBeGreaterThanOrEqual(reportingRadius(v.zoom) * 2)               // clear of the mandatory point it was on
  })
  it('a VFR point on a mandatory point moves away from it even with nothing else near', () => {
    const out = displaceWaypoints(fc(wp('NORTH', 'MRP'), wp('KVARN', 'RP')), [], v)
    expect((out.features[0] as unknown as { properties: Record<string, unknown> }).properties['displaced']).toBeUndefined()
    expect((out.features[1] as unknown as { properties: Record<string, unknown> }).properties['displaced']).toBe(true)
  })
  it('holding points are fixed too, and a lone VFR point does not move', () => {
    const out = displaceWaypoints(fc(wp('HOLDING WEST', 'RP'), wp('KVARN', 'RP', 0.02)), [], v)
    expect(out).toEqual(fc(wp('HOLDING WEST', 'RP'), wp('KVARN', 'RP', 0.02)))
    expect(restore(displaceWaypoints(fc(wp('NORTH', 'MRP'), wp('KVARN', 'RP')), [], v))).toEqual(fc(wp('NORTH', 'MRP'), wp('KVARN', 'RP')))
  })
  it('a club point keeps clear of every base waypoint, mandatory ones included', () => {
    const base = fc(wp('NORTH', 'MRP'))
    const club = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      properties: { kind: 'reporting_point', aerodrome: 'ESXX', name: 'Club point' } }] } as FeatureCollection
    const out = displaceReportingPoints(club, waypointBlockers(base, v.zoom), v)
    expect((out.features[0].properties as Record<string, unknown>)['displaced']).toBe(true)
  })
})
