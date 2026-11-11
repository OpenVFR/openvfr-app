import { describe, it, expect } from 'vitest'
import {
  parseAerodromeDetails, localInfo, formatCircuit, formatLimits, schematicCircuit, schematicCircuitFeatures, hasLocalInfo,
  SCHEMATIC_OFFSET_NM, type DetailFeature,
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

describe('schematicCircuit', () => {
  it('puts the pattern on the stated side, at the stated offset', () => {
    const left = schematicCircuit(RWYS, { runway: '12', direction: 'left', altitude_ft: null, altitude_ref: null, aircraft: null })!
    const right = schematicCircuit(RWYS, { runway: '12', direction: 'right', altitude_ft: null, altitude_ref: null, aircraft: null })!
    expect(left.coordinates).toHaveLength(6)
    expect(left.coordinates[0]).toEqual([13.325088, 55.851489])                    // starts at the take-off end
    // Side of the downwind leg relative to the take-off direction: cross product > 0 = left.
    const k = Math.cos((55.85 * Math.PI) / 180)
    const side = (p: number[]) => {
      const ux = (13.334574 - 13.325088) * k, uy = 55.846665 - 55.851489
      return Math.sign(ux * (p[1]! - 55.851489) - uy * (p[0]! - 13.325088) * k)
    }
    for (const i of [2, 3]) {
      expect(side(left.coordinates[i]!)).toBe(1)
      expect(side(right.coordinates[i]!)).toBe(-1)
    }
    expect(dist(left.coordinates[2]!, left.coordinates[1]!) / 1852).toBeCloseTo(SCHEMATIC_OFFSET_NM, 2)
    expect(schematicCircuit(RWYS, { runway: '18', direction: 'left', altitude_ft: null, altitude_ref: null, aircraft: null })).toBeNull()
    expect(schematicCircuit(RWYS, { runway: '12', direction: null, altitude_ft: null, altitude_ref: null, aircraft: null })).toBeNull()
  })

  it('one picture per runway side, named after every runway direction using it', () => {
    const ad = (icao: string, circuits: unknown[]) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [13.33, 55.85] },
      properties: { icao, runways: RWYS, circuits, provenance: { circuits: { review: 'pending' } } } })
    // 12 left-hand and 30 right-hand are the same rectangle (flown in opposite directions); categories share it
    const same = schematicCircuitFeatures([ad('ESME', [{ runway: '12', direction: 'left' }, { runway: '12', direction: 'left', aircraft: 'ultralight' },
      { runway: '30', direction: 'right' }])], new Set())
    expect(same.map(x => [x.properties.name, x.properties.oneWay])).toEqual([['RWY 12 LH · RWY 30 RH', false]])
    // 12 right-hand and 30 right-hand lie on opposite sides: two pictures, each with a direction
    const both = schematicCircuitFeatures([ad('ESME', [{ runway: '12', direction: 'right' }, { runway: '30', direction: 'right' }])], new Set())
    expect(both.map(x => [x.properties.name, x.properties.oneWay])).toEqual([['RWY 12 RH', true], ['RWY 30 RH', true]])
    expect(both.every(x => x.properties.schematic && x.properties.pending && x.properties.aerodrome === 'ESME')).toBe(true)
    // "12R"/"30R" in the AIP where the runway data says "12/30" and "12/30 GRASS": gliders on the grass strip
    const thr = (lat: number) => [{ designator: '12', lat, lon: 12.85 }, { designator: '30', lat: lat - 0.005, lon: 12.87 }]
    const esml = { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [12.86, 55.94] }, properties: { icao: 'ESML',
      runways: [{ designator: '12/30', thresholds: thr(55.945) }, { designator: '12/30 GRASS', thresholds: thr(55.946) }],
      circuits: [{ runway: '12R', direction: 'right', aircraft: 'powered' }, { runway: '30R', direction: 'right', aircraft: 'glider' },
        { runway: '30', direction: 'left', aircraft: 'powered' }, { runway: '12', direction: 'left', aircraft: 'glider' }] } }
    const ml = schematicCircuitFeatures([esml], new Set())
    expect(ml.map(x => x.properties.name)).toEqual(['RWY 12 RH · RWY 30 LH', 'RWY 30 RH · RWY 12 LH'])
    const startLat = (x: DetailFeature) => (x.geometry as LineString).coordinates[0]![1]
    expect([startLat(ml[0]!), startLat(ml[1]!)]).toEqual([55.945, 55.941])
    // circuits for heavy aircraft only are listed, never drawn
    expect(schematicCircuitFeatures([ad('ESMS', [{ runway: '12', direction: 'right', aircraft: 'heavy' }])], new Set())).toEqual([])
    expect(formatCircuit({ runway: '17', direction: 'right', altitude_ft: null, altitude_ref: null, aircraft: 'heavy' }))
      .toBe('RWY 17 · right-hand · aircraft over 5700 kg MTOM')
    // aerodromes whose circuit is drawn in the details file get no schematic one
    expect(schematicCircuitFeatures([ad('ESXX', [{ runway: '12', direction: 'left' }])], new Set(['ESXX']))).toEqual([])
  })
})
