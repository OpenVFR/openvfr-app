import { describe, it, expect } from 'vitest'
import {
  parseAerodromeDetails, localInfo, formatCircuit, formatLimits, circuitTurnArrow, schematicCircuitFeatures, hasLocalInfo, holdingOrbit,
  holdingOrbitFeatures, ORBIT_RADIUS_NM,
  TURN_STRAIGHT_NM, TURN_RADIUS_NM, type DetailFeature,
} from './aerodromeDetails'
import type { LineString } from 'geojson'

// ESME-like runway 12/30 (real thresholds), circuits as a deployment publishes them.
const RWYS = [{ designator: '12/30', thresholds: [
  { designator: '12', lat: 55.851489, lon: 13.325088 }, { designator: '30', lat: 55.846665, lon: 13.334574 },
] }]
const dist = (a: number[], b: number[]) =>
  Math.hypot((a[0]! - b[0]!) * 111_320 * Math.cos((55.85 * Math.PI) / 180), (a[1]! - b[1]!) * 110_540)

describe('parseAerodromeDetails', () => {
  it('keeps valid features, normalises kinds and limits, drops the rest', () => {
    const fc = parseAerodromeDetails({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[13, 55], [13.1, 55], [13.1, 55.1], [13, 55]]] },
        properties: { icao: 'ESME', kind: 'noise_sensitive', name: ' Village ', floor: { ref: 'AGL', ft: 0 }, ceiling: { ref: 'AMSL', ft: 2000 },
          geometry_quality: 'approximate', accuracy_m: 352.4, provenance: { source_name: 'X', source_url: 'javascript:alert(1)', review: 'pending' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [13, 55] }, properties: { local_id: 'se-x', kind: 'weird' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [200, 55] }, properties: { icao: 'ESXX', kind: 'reporting_point' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [13, 55] }, properties: { kind: 'reporting_point' } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[13, 55], [13.1, 55]]] }, properties: { icao: 'ESXX' } },
    ] })!
    expect(fc.features).toHaveLength(2)
    const a = fc.features[0]!.properties
    expect([a.aerodrome, a.kind, a.name, a.approximate, a.accuracy_m, a.pending]).toEqual(['ESME', 'noise_sensitive', 'Village', true, 352, true])
    expect(formatLimits(a.floor, a.ceiling)).toBe('GND – 2000 ft AMSL')
    expect(a.provenance?.source_url).toBeNull()                                      // only https links survive
    expect(fc.features[1]!.properties).toMatchObject({ aerodrome: 'se-x', kind: 'other', pending: false })
    expect(parseAerodromeDetails({ type: 'Feature' })).toBeNull()
  })
})

describe('localInfo', () => {
  it('reads fields whether nested or JSON-serialised, and marks unreviewed ones', () => {
    const props = {
      circuits: JSON.stringify([{ runway: '12', direction: 'left', altitude_ft: 1300, altitude_ref: 'QNH', aircraft: null },
                                { runway: '30', direction: 'up', altitude_ft: -5 }]),
      local_rules: ['Report intentions before entering the circuit', ''],
      ppr_remarks: 'PPR for night',
      areas: [{ kind: 'glider_area', name: 'Winch', floor: { ref: 'AGL', ft: 0 }, ceiling: { ref: 'FL', ft: 6500 } }],
      reporting_points: [{ name: 'LYCKAN' }, { name: '' }],
      provenance: { circuits: { source_name: 'AIP', review: 'pending' }, local_rules: { source_name: 'AIP' } },
    }
    const i = localInfo(props)
    expect(i.circuits.map(formatCircuit)).toEqual(['RWY 12 · left-hand · 1300 ft QNH', 'RWY 30 · direction not stated'])
    expect(i.localRules).toEqual(['Report intentions before entering the circuit'])
    expect(i.pprRemarks).toEqual(['PPR for night'])
    expect(formatLimits(i.areas[0]!.floor, i.areas[0]!.ceiling)).toBe('GND – FL065')
    expect(i.reportingPoints).toEqual([{ name: 'LYCKAN', remark: null }])
    expect([i.provenance['circuits']?.review, i.provenance['local_rules']?.review]).toEqual(['pending', undefined])
    expect(hasLocalInfo(i)).toBe(true)
    expect(hasLocalInfo(localInfo({}))).toBe(false)
  })
})

const C = (runway: string, direction: 'left' | 'right' | null, aircraft: string | null = null) =>
  ({ runway, direction, altitude_ft: null, altitude_ref: null, aircraft })

describe('circuitTurnArrow', () => {
  it('starts at the departure end and turns toward the stated side', () => {
    const left = circuitTurnArrow(RWYS, C('12', 'left'))!
    const right = circuitTurnArrow(RWYS, C('12', 'right'))!
    // take-off on 12 (towards SE) departs over the 30 threshold
    expect(left.arc.coordinates[0]).toEqual([13.334574, 55.846665])
    expect(left.designator).toBe('12')
    // heading ~125 deg: left of track is NE, right is SW; both tips equally far along the track
    const tipL = left.head.coordinates[1]!, tipR = right.head.coordinates[1]!
    expect(tipL[1]!).toBeGreaterThan(tipR[1]!)
    expect(tipL[0]!).toBeGreaterThan(tipR[0]!)
    // tip lies TURN_STRAIGHT + TURN_RADIUS beyond the end and TURN_RADIUS to the side
    const d = dist(tipL, [13.334574, 55.846665]) / 1852
    expect(d).toBeCloseTo(Math.hypot(TURN_STRAIGHT_NM + TURN_RADIUS_NM, TURN_RADIUS_NM), 1)
    expect(circuitTurnArrow(RWYS, C('18', 'left'))).toBeNull()
    expect(circuitTurnArrow(RWYS, C('12', null))).toBeNull()
  })

  it('one arrow per runway end and direction, categories merged and named only when not for everyone', () => {
    const ad = (icao: string, circuits: unknown[], runways: unknown = RWYS) => ({ type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [13.33, 55.85] },
      properties: { icao, runways, circuits, provenance: { circuits: { review: 'pending' } } } })
    const names = (fs: DetailFeature[]) => fs.filter(f => f.properties.role === 'label').map(f => f.properties.name)
    const fs = schematicCircuitFeatures([ad('ESME', [C('12', 'left'), C('12', 'left', 'ultralight'), C('30', 'right')])], new Set())
    expect(names(fs)).toEqual(['RWY 12 LH', 'RWY 30 RH'])
    expect(fs).toHaveLength(6)                                          // arc + head + label each
    expect(fs.every(f => f.properties.schematic && f.properties.pending && f.properties.aerodrome === 'ESME')).toBe(true)
    expect(fs.filter(f => f.properties.role === 'label').map(f => f.properties.rwys)).toEqual(['|12|', '|30|'])
    expect(names(schematicCircuitFeatures([ad('ESME', [C('30', 'right', 'glider')])], new Set()))).toEqual(['RWY 30 RH · gliders'])

    // "12R"/"30R" in the AIP where the runway data says "12/30" and "12/30 GRASS": gliders on the grass strip
    const thr = (lat: number) => [{ designator: '12', lat, lon: 12.85 }, { designator: '30', lat: lat - 0.005, lon: 12.87 }]
    const esml = ad('ESML', [C('12R', 'right', 'powered'), C('30R', 'right', 'glider'), C('12', 'right', 'helicopter')],
      [{ designator: '12/30', thresholds: thr(55.945) }, { designator: '12/30 GRASS', thresholds: thr(55.946) }])
    const ml = schematicCircuitFeatures([esml], new Set())
    expect(names(ml)).toEqual(['RWY 12 RH', 'RWY 30 RH · gliders'])
    const start = (f: DetailFeature) => (f.geometry as LineString).coordinates[0]![1]
    // 12 departs over the asphalt 30 threshold, 30 (gliders) over the grass 12 threshold
    expect(ml.filter(f => f.properties.role === 'turn' && (f.geometry as LineString).coordinates.length > 3).map(start))
      .toEqual([55.94, 55.946])

    // circuits for heavy aircraft only are listed, never drawn
    expect(schematicCircuitFeatures([ad('ESMS', [C('12', 'right', 'heavy')])], new Set())).toEqual([])
    expect(formatCircuit(C('17', 'right', 'heavy'))).toBe('RWY 17 · right-hand · aircraft over 5700 kg MTOM')
    // aerodromes whose circuit is drawn in the details file get no arrows
    expect(schematicCircuitFeatures([ad('ESXX', [C('12', 'left')])], new Set(['ESXX']))).toEqual([])
  })
})

describe('drawn circuits from a club chart', () => {
  it('keep their runway ends and sense, reject malformed ones', () => {
    const fc = parseAerodromeDetails({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[12.55, 56.16], [12.56, 56.17]] },
        properties: { icao: 'ESMH', kind: 'circuit_leg', name: 'RWY 06 RH · RWY 24 LH', rwys: '|06|24|', oneWay: false,
          geometry_quality: 'approximate', accuracy_m: 14 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[12.55, 56.16], [12.56, 56.17]] },
        properties: { icao: 'ESMH', kind: 'circuit_leg', rwys: "06') or 1=1", oneWay: 'no' } },
    ] })!
    expect(fc.features[0]!.properties).toMatchObject({ rwys: '|06|24|', oneWay: false, approximate: true, accuracy_m: 14 })
    expect(fc.features[1]!.properties.rwys).toBeUndefined()
    expect(fc.features[1]!.properties.oneWay).toBeUndefined()
  })
})

describe('provenance sources', () => {
  it('keeps every source of a merged field, https links only', () => {
    const info = localInfo({ circuits: [], provenance: { circuits: { source_name: 'LFV eAIP Sweden', source_url: 'https://aip/x',
      sources: [{ source_name: 'LFV eAIP Sweden', source_url: 'https://aip/x', method: 'official' },
        { source_name: 'nsf.se', source_url: 'javascript:alert(1)', method: 'unofficial' }] } } })
    expect(info.provenance['circuits']!.sources).toEqual([
      { source_name: 'LFV eAIP Sweden', source_url: 'https://aip/x', method: 'official' },
      { source_name: 'nsf.se', source_url: null, method: 'unofficial' }])
  })
})

describe('holdings', () => {
  it('orbit: left is counter-clockwise, on a circle of ORBIT_RADIUS_NM around the point', () => {
    const c: [number, number] = [13.3275, 55.535]
    const [arc, head] = holdingOrbit(c, 'left')
    for (const p of arc.coordinates) expect(dist(p, c) / 1852).toBeCloseTo(ORBIT_RADIUS_NM, 2)
    // signed area of the arc around the centre > 0 = counter-clockwise
    const cross = (o: number[]) => arc.coordinates.slice(1).reduce((s, p, i) => {
      const a = arc.coordinates[i]!; return s + (a[0]! - o[0]!) * (p[1]! - o[1]!) - (p[0]! - o[0]!) * (a[1]! - o[1]!)
    }, 0)
    expect(cross(c)).toBeGreaterThan(0)
    const [arcR] = holdingOrbit(c, 'right')
    const crossR = arcR.coordinates.slice(1).reduce((s, p, i) => {
      const a = arcR.coordinates[i]!; return s + (a[0]! - c[0]) * (p[1]! - c[1]) - (p[0]! - c[0]) * (a[1]! - c[1])
    }, 0)
    expect(crossR).toBeLessThan(0)
    expect(head.coordinates[1]).toEqual(arc.coordinates[arc.coordinates.length - 1])   // arrowhead at the arc's end
  })

  it('parses holding points and their direction, draws only those with a direction', () => {
    const fc = parseAerodromeDetails({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [13.3275, 55.535] },
        properties: { icao: 'ESMS', kind: 'holding', name: 'WEST', direction: 'left', remarks: 'Left circuit west of lake' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [13.42, 55.53] },
        properties: { icao: 'ESMS', kind: 'holding', name: 'EAST', direction: 'up' } },
    ] })!
    expect(fc.features.map(f => [f.properties.kind, f.properties.direction])).toEqual([['holding', 'left'], ['holding', undefined]])
    const orbits = holdingOrbitFeatures(fc.features)
    expect(orbits).toHaveLength(2)
    expect(orbits.every(o => o.properties.role === 'turn' && o.properties.name === 'WEST')).toBe(true)
    const info = localInfo({ holdings: JSON.stringify([{ name: 'WEST', direction: 'left', description: 'Left circuit west of lake' },
      { name: 'EAST', direction: 'x' }]) })
    expect(info.holdings).toEqual([{ name: 'WEST', direction: 'left', description: 'Left circuit west of lake' },
      { name: 'EAST', direction: null, description: null }])
    expect(hasLocalInfo(info)).toBe(true)
  })
})
