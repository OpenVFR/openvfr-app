import { describe, it, expect } from 'vitest'
import {
  parseAerodromeDetails, localInfo, formatCircuit, formatLimits, circuitTurnArrow, schematicCircuitFeatures, hasLocalInfo, holdingOrbit,
  holdingOrbitFeatures, ORBIT_RADIUS_NM, localAreaInfo, RULE_GROUP_IDS, RULE_GROUP_LABEL,
  TURN_STRAIGHT_NM, TURN_RADIUS_NM, endsOfDesignator, runwayEndsOf, circuitEndGroups, circuitNotes, heightRefLabel, unstatedCircuitEnds, unstatedCircuitNote, type DetailFeature,
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
    expect(i.circuits.map(formatCircuit)).toEqual(['RWY 12 · left-hand · 1300 ft AMSL', 'RWY 30 · direction not stated'])
    expect(i.localRules).toEqual(['Report intentions before entering the circuit'])
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

describe('localAreaInfo', () => {
  it('says what the area is, how exact it is and where it comes from', () => {
    const i = localAreaInfo({ kind: 'noise_sensitive', aerodrome: 'ESSN', name: 'Lönsvik', remarks: null, approximate: true, accuracy_m: 86.4,
      pending: true, limits: '', source: 'www.rfk.nu' })
    expect(i).toMatchObject({ areaKind: 'noise_sensitive', kindLabel: 'Noise-sensitive area', name: 'Lönsvik', note: 'Avoid overflight.', accuracyM: 86, approximate: true, pending: true, limits: null, source: 'www.rfk.nu' })
  })
  it('says avoid overflight, below the height when one is stated, and claims nothing when none is', () => {
    expect(localAreaInfo({ kind: 'noise_sensitive', below: '2500 ft AMSL', remarks: 'avoid below 2500 ft AMSL' })).toMatchObject({ note: 'Avoid overflight below 2500 ft AMSL.', below: '2500 ft AMSL' })
    expect(localAreaInfo({ kind: 'noise_sensitive', below: '' })).toMatchObject({ note: 'Avoid overflight.', below: null })
  })
  it('prefers the source remark to the kind note', () => {
    expect(localAreaInfo({ kind: 'noise_sensitive', remarks: 'avoid below 2500 ft AMSL', limits: 'GND – 2500 ft AMSL' })).toMatchObject({ note: 'avoid below 2500 ft AMSL', limits: 'GND – 2500 ft AMSL' })
  })
  it('reads values MapLibre returns as strings', () => {
    expect(localAreaInfo({ kind: 'circuit_leg', name: 'RWY 07 RH · RWY 25 LH', approximate: 'true', pending: 'false', accuracy_m: '86' }))
      .toMatchObject({ kindLabel: 'Circuit', approximate: true, pending: false, accuracyM: 86 })
  })
  it('has no popup for turn arrows, labels and other points', () => {
    expect(localAreaInfo({ kind: 'circuit_leg', role: 'turn' })).toBeNull()
    expect(localAreaInfo({ kind: 'taxiway' })).toBeNull()
    expect(localAreaInfo(null)).toBeNull()
  })
})

describe('grouped local rules', () => {
  const line = (title: string, text: string, key = false) => ({ title, text, key })
  const many = [line('Animals', 'Deer on the field'), line('AIP', 'Obstacle 1 NM NE', true), line('Other', 'Phone for field check'),
    line('Noise and neighbours', 'No overflight of the farm', true), line('Noise and neighbours', 'Avoid the red areas'),
    line('Procedures', 'Report arrival 123.4'), line('Obstacles', 'Turbines east, 200 ft')]
  it('groups in a fixed order with the key lines marked', () => {
    const g = localInfo({ local_rules: many.map(x => x.text), local_rule_groups: many }).localRuleGroups!
    expect(g.map(x => x.title)).toEqual(['AIP', 'Obstacles', 'Noise and neighbours', 'Animals', 'Procedures', 'Other'])
    expect(g[2].lines).toEqual([{ text: 'No overflight of the farm', key: true }, { text: 'Avoid the red areas', key: false }])
  })
  it('every group has a stable id apart from its text, unknown headings keep their own', () => {
    const g = localInfo({ local_rule_groups: [...many, line('Fuel stop', 'Self service')] }).localRuleGroups!
    expect(g.map(x => x.id)).toEqual(['aip', 'obstacles', 'noise_neighbours', 'animals', 'procedures', 'other', 'Fuel stop'])
    expect(g.map(x => x.title)).toEqual(['AIP', 'Obstacles', 'Noise and neighbours', 'Animals', 'Procedures', 'Other', 'Fuel stop'])
    for (const id of RULE_GROUP_IDS) expect(RULE_GROUP_LABEL[id]).toBeTruthy()
  })
  it('an unknown heading comes after every known one, "Other" included, whatever the data order', () => {
    const g = localInfo({ local_rule_groups: [line('Fuel stop', 'Self service'), ...many] }).localRuleGroups!
    expect(g.map(x => x.title).slice(-2)).toEqual(['Other', 'Fuel stop'])
  })
  it('a short list stays plain, and so does one without groups', () => {
    expect(localInfo({ local_rules: ['a'], local_rule_groups: many.slice(0, 3) }).localRuleGroups).toBeNull()
    expect(localInfo({ local_rules: ['a'] }).localRuleGroups).toBeNull()
  })
  it('accepts the JSON string MapLibre makes of a nested property', () => {
    expect(localInfo({ local_rule_groups: JSON.stringify(many) }).localRuleGroups).toHaveLength(6)
  })
})

describe('circuit note: runways without a published circuit', () => {
  it('names the two ends of a designator, also a one-end one and a side letter', () => {
    expect(endsOfDesignator('12/30')).toEqual(['12', '30'])
    expect(endsOfDesignator('18')).toEqual(['18', '36'])
    expect(endsOfDesignator('36')).toEqual(['36', '18'])
    expect(endsOfDesignator('04L')).toEqual(['04L', '22R'])
    expect(endsOfDesignator('GRASS')).toEqual([])
  })

  it('lists every runway end once, from the thresholds when it has them', () => {
    expect(runwayEndsOf([{ designator: '14/32' }, { designator: '04/22' }, { designator: '14/32' }])).toEqual(['14', '32', '04', '22'])
    expect(runwayEndsOf(RWYS)).toEqual(['12', '30'])
  })

  it('says which ends are not stated only when some circuit is published (ESTA: RWY 32 only)', () => {
    const info = (circuits: { runway: string; aircraft?: string | null }[]) => ({
      runwayEnds: ['14', '32', '04', '22'],
      circuits: circuits.map(c => ({ runway: c.runway, direction: 'right' as const, altitude_ft: null, altitude_ref: null, aircraft: c.aircraft ?? null })),
    })
    expect(unstatedCircuitEnds(info([{ runway: '32' }]))).toEqual(['14', '04', '22'])
    expect(unstatedCircuitEnds(info([]))).toEqual([])                                    // nothing published: no note, no block
    expect(unstatedCircuitEnds(info([{ runway: '32', aircraft: 'heavy' }]))).toEqual([])  // a circuit for heavy aircraft only does not count as published
    expect(unstatedCircuitEnds(info([{ runway: 'RWY 14L' }]))).toEqual(['32', '04', '22'])
    expect(unstatedCircuitNote(['14', '04'])).toBe('Not stated for RWY 14, 04. The ICAO standard is left-hand unless published otherwise.')
  })

  it('localInfo carries the runway ends', () => {
    expect(localInfo({ runways: [{ designator: '12/30' }], circuits: [] }).runwayEnds).toEqual(['12', '30'])
  })
})

describe('circuitEndGroups', () => {
  const c = (runway: string, direction: 'left' | 'right' | null, altitude_ft: number | null, aircraft: string | null = null) =>
    ({ runway, direction, altitude_ft, altitude_ref: altitude_ft ? 'QNH' : null, aircraft })

  it('groups by runway end in runway order and states a shared height once', () => {
    const g = circuitEndGroups([c('30', 'right', 1300), c('12', 'left', 1300), c('12', 'right', 1300, 'glider')])
    expect(g.summary).toBe('Circuit height 1300 ft AMSL')
    expect(g.ends.map(e => e.runway)).toEqual(['12', '30'])
    expect(g.ends[0]!.entries.map(e => e.text)).toEqual(['\u21B7 right-hand \u00B7 glider', '\u21B6 left-hand \u00B7 other aircraft'])
  })

  it('keeps each height on its own entry when they differ, and with a single circuit', () => {
    const g = circuitEndGroups([c('12', 'left', 1000), c('30', 'right', 1300)])
    expect(g.summary).toBeNull()
    expect(g.ends[1]!.entries[0]!.text).toBe('\u21B7 right-hand \u00B7 1300 ft AMSL')
    expect(circuitEndGroups([c('04', 'left', 1200)]).ends[0]!.entries[0]!.text).toBe('\u21B6 left-hand \u00B7 1200 ft AMSL')
  })

  it('says when a direction is not stated and drops an identical repeat', () => {
    const g = circuitEndGroups([c('RWY 18', null, null), c('18', null, null)])
    expect(g.ends).toHaveLength(1)
    expect(g.ends[0]!.entries).toEqual([{ direction: null, text: 'direction not stated' }])
  })
})

describe('circuit heights and notes', () => {
  it('says when a height has no reference instead of leaving it bare', () => {
    const g = circuitEndGroups([{ runway: '12', direction: 'left', altitude_ft: 1000, altitude_ref: null, aircraft: null }])
    expect(g.ends[0]!.entries[0]!.text).toBe('\u21B6 left-hand \u00B7 1000 ft (reference not stated)')
  })

  it('lists the notes of drawn circuits once, with the circuit name, and not those of arrows or other aerodromes', () => {
    const f = (aerodrome: string, remarks: string | null, schematic = false, type: 'LineString' | 'Point' = 'LineString'): DetailFeature => ({
      type: 'Feature',
      geometry: type === 'LineString' ? { type: 'LineString', coordinates: [[13, 55], [13.1, 55.1]] } : { type: 'Point', coordinates: [13, 55] },
      properties: { aerodrome, kind: 'circuit_leg', name: 'Traffic circuit gliders (runway 12)', remarks, schematic } as DetailFeature['properties'],
    })
    expect(circuitNotes([f('ESMI', 'At least 150 m AGL on downwind.'), f('ESMI', 'At least 150 m AGL on downwind.'), f('ESMI', null), f('ESMI', 'x', true), f('ESXX', 'y')], 'ESMI'))
      .toEqual(['Traffic circuit gliders (runway 12): At least 150 m AGL on downwind.'])
  })
})

describe('heightRefLabel', () => {
  it('reads QNH as AMSL and AAL as AGL, and leaves anything else', () => {
    expect([heightRefLabel('QNH'), heightRefLabel('qnh'), heightRefLabel('AAL'), heightRefLabel('MSL'), heightRefLabel(null)]).toEqual(['AMSL', 'AMSL', 'AGL', 'MSL', null])
  })
})
