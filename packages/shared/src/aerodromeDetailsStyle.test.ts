import { describe, it, expect } from 'vitest'
import { DETAIL_LAYERS, staticColorLayers, layerFilter, buildDetailsMapData, circuitLabel, mapAreaLabel, belowText, CIRCUIT_LAYER_IDS, LABEL_ANCHORS, landmarkLabelFilter, landmarkNamesTakenByPoints } from './aerodromeDetailsStyle'
import { DETAIL_KIND_COLOR, CIRCUIT_GROUP_COLOR, parseAerodromeDetails, schematicCircuitFeatures, localAreaInfo } from './aerodromeDetails'

describe('aerodromeDetailsStyle', () => {
  it('static-colour layers never compute a colour from feature properties', () => {
    const layers = staticColorLayers()
    const colourKeys = (p: Record<string, unknown>) => Object.entries(p).filter(([k]) => /-color$/.test(k))
    for (const l of layers) for (const [, v] of colourKeys(l.paint)) expect(typeof v).toBe('string')
    // circuits: one layer per aircraft group, each with its own fixed colour
    expect(layers.find(l => l.id === 'ad-circuit-turn-powered')!.paint['line-color']).toBe(CIRCUIT_GROUP_COLOR.powered)
    expect(layers.find(l => l.id === 'ad-circuit-line-glider')!.paint['line-color']).toBe(CIRCUIT_GROUP_COLOR.glider)
    expect(JSON.stringify(layers.find(l => l.id === 'ad-circuit-line-ultralight')!.filter)).toContain('"ultralight"')
    expect(layers.find(l => l.id === 'ad-holding-orbit-holding')!.group).toBe('holdings')
    expect(new Set(layers.map(l => l.id)).size).toBe(layers.length)
  })

  it('runway focus narrows only circuit layers', () => {
    const f = { aerodrome: 'ESMH', runway: '06' }
    const circuit = DETAIL_LAYERS.find(l => l.id === CIRCUIT_LAYER_IDS[0])!
    expect(JSON.stringify(layerFilter(circuit, f))).toContain('|06|')
    const fill = DETAIL_LAYERS.find(l => l.id === 'ad-details-fill')!
    expect(layerFilter(fill, f)).toBe(fill.filter)
    expect(layerFilter(circuit, null)).toBe(circuit.filter)
  })

  it('map data: turn arrows from aerodrome circuits, labels only for areas and points', () => {
    const ad = { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [13.33, 55.85] }, properties: {
      icao: 'ESME', circuits: [{ runway: '12', direction: 'left' }],
      runways: [{ designator: '12/30', thresholds: [{ designator: '12', lat: 55.851489, lon: 13.325088 },
        { designator: '30', lat: 55.846665, lon: 13.334574 }] }] } }
    const fc = buildDetailsMapData([], [ad])
    expect(fc.features.map(f => f.properties.role)).toEqual(['turn', 'turn', 'label'])
    expect(fc.features.every(f => f.properties.label === '')).toBe(true)
    expect(fc.features.find(f => f.properties.role === 'label')!.properties.clabel).toBe('12 LH')
    expect(circuitLabel('RWY 06 RH · RWY 24 LH')).toBe('06 RH · 24 LH')
    expect(circuitLabel('RWY 30 RH · gliders')).toBe('30 RH · gliders')
    expect(circuitLabel('ESMI UL-landningsvarv')).toBe('UL-landningsvarv')
    expect(circuitLabel('Traffic circuit gliders (runway 12) \u2014 RWY 12 RH \u00B7 RWY 30 LH', 'glider')).toBe('gliders \u00B7 12 RH \u00B7 30 LH')
    expect(circuitLabel('Traffic circuit powered aircraft (runway 12)')).toBe('powered aircraft')
    expect(circuitLabel('Traffic circuit UL (runway 30) \u2014 RWY 30 RH')).toBe('UL \u00B7 30 RH')
    // labels are dark on a white halo, never the (light) line colour
    for (const id of ['ad-circuit-label', 'ad-circuit-turn-label']) {
      expect(DETAIL_LAYERS.find(l => l.id === id)!.paint['text-color']).toBe('#0c4a6e')
    }
  })

  it('circuits carry their aircraft group: drawn (club map) and turn arrows for one group', () => {
    const fc = parseAerodromeDetails({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[13.8, 55.58], [13.82, 55.58]] },
        properties: { icao: 'ESMI', kind: 'circuit_leg', name: 'ESMI UL-landningsvarv', aircraft: 'ultralight' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[13.8, 55.58], [13.82, 55.58]] },
        properties: { icao: 'ESMI', kind: 'circuit_leg', name: 'x', aircraft: 'spaceship' } },
    ] })!
    expect(fc.features.map(f => f.properties.aircraft)).toEqual(['ultralight', undefined])
    const ad = { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [13.33, 55.85] }, properties: {
      icao: 'ESME', circuits: [{ runway: '12', direction: 'left', aircraft: 'glider' }, { runway: '30', direction: 'left' }],
      runways: [{ designator: '12/30', thresholds: [{ designator: '12', lat: 55.851489, lon: 13.325088 },
        { designator: '30', lat: 55.846665, lon: 13.334574 }] }] } }
    const arrows = schematicCircuitFeatures([ad], new Set()).filter(f => f.properties.role === 'label')
    expect(arrows.map(f => [f.properties.name, f.properties.aircraft])).toEqual([['RWY 12 LH · gliders', 'glider'], ['RWY 30 LH', undefined]])
  })
})

describe('mapAreaLabel', () => {
  it('labels a noise-sensitive area by its name alone', () => {
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: 'Central Västerås', floor: null, ceiling: null })).toBe('Central Västerås')
  })
  it('drops the kind words the source put in the name', () => {
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: 'Noise-sensitive area Kastberga', floor: null, ceiling: null })).toBe('Kastberga')
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: 'Bullerkänsligt omr Djurgården', floor: null, ceiling: null })).toBe('Djurgården')
  })
  it('gives an unnamed noise-sensitive area no label (the outline and the tap say what it is)', () => {
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: null, floor: null, ceiling: null })).toBe('')
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: 'Noise-sensitive area', floor: null, ceiling: null })).toBe('')
  })
  it('a noise-sensitive area with a height says it below that height', () => {
    const lim = { floor: { ref: 'AGL' as const, ft: 0 }, ceiling: { ref: 'AMSL' as const, ft: 2500 } }
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: 'Kil', ...lim })).toBe('Kil\nbelow 2500 ft AMSL')
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: null, ...lim })).toBe('below 2500 ft AMSL')
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: 'Kil', ...lim }, false)).toBe('Kil')           // the map itself shows no height
    expect(mapAreaLabel({ kind: 'noise_sensitive', name: null, ...lim }, false)).toBe('')
    expect(belowText(lim.floor, lim.ceiling)).toBe('2500 ft AMSL')
    expect(belowText(null, { ref: 'UNL' })).toBeNull()
    expect(belowText({ ref: 'AMSL', ft: 1000 }, { ref: 'AMSL', ft: 2500 })).toBeNull()      // a band above the ground is not "below"
  })
  it('keeps the kind in front of the name for other areas', () => {
    expect(mapAreaLabel({ kind: 'glider_area', name: 'Öresjö', floor: null, ceiling: null })).toBe('Glider area: Öresjö')
    expect(mapAreaLabel({ kind: 'avoid_area', name: null, floor: null, ceiling: null })).toBe('Avoid area')
  })
})

describe('arrival routes', () => {
  const route = {
    type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [[13, 55], [13.01, 55.01]] },
    properties: { icao: 'ESTT', kind: 'arrival_route', name: 'Fly-in and join', geometry_quality: 'approximate' },
  }
  it('is its own kind but is drawn, named and switched like a circuit', () => {
    const fc = parseAerodromeDetails({ type: 'FeatureCollection', features: [route] })!
    expect(fc.features[0]!.properties.kind).toBe('arrival_route')
    const data = buildDetailsMapData(fc.features, [])
    expect(data.features[0]!.properties).toMatchObject({ clabel: 'Fly-in and join', label: '' })
    const line = DETAIL_LAYERS.find(l => l.id === 'ad-circuit-line-dashed')!
    expect(line.group).toBe('circuits')
    expect(JSON.stringify(line.filter)).toContain('arrival_route')
    expect(JSON.stringify(DETAIL_LAYERS.find(l => l.id === 'ad-details-line-dashed')!.filter)).toContain('arrival_route')   // excluded from the plain-line layer
    expect(staticColorLayers().some(l => l.id === 'ad-circuit-line-dashed-powered')).toBe(true)     // native
    // a fly-in route has its own colour and is never drawn by a group layer
    const routeLayer = staticColorLayers().find(l => l.id === 'ad-circuit-line-route')!
    expect(routeLayer.paint['line-color']).toBe(DETAIL_KIND_COLOR.arrival_route)
    expect(JSON.stringify(staticColorLayers().find(l => l.id === 'ad-circuit-line-powered')!.filter)).toContain('arrival_route')
  })
  it('opens a tap popup', () => {
    expect(localAreaInfo({ aerodrome: 'ESTT', kind: 'arrival_route', name: 'Fly-in and join' })).toMatchObject({ kindLabel: 'Arrival route', name: 'Fly-in and join' })
  })
})

describe('reporting points of a club map: only for the relevant aerodrome', () => {
  it('filters by the aerodromes whose card was opened', () => {
    const icon = DETAIL_LAYERS.find(l => l.id === 'ad-reporting-point-icon')!
    const f = layerFilter(icon, null, ['ESTT'])
    expect(JSON.stringify(f)).toContain('"ESTT"')
    expect(JSON.stringify(f)).toContain('aerodrome')
    expect(JSON.stringify(layerFilter(icon, null, []))).toContain('"literal",[]')            // none relevant: nothing drawn
    expect(layerFilter(icon, null)).toEqual(icon.filter)                                       // no rule given: unchanged
    const circuit = DETAIL_LAYERS.find(l => l.id === CIRCUIT_LAYER_IDS[0])!
    expect(layerFilter(circuit, null, ['ESTT'])).toEqual(circuit.filter)                       // circuits are not affected
  })
})

describe('reporting points of a club map', () => {
  it('are drawn as the VFR reporting-point triangle, in a group of their own, and not twice', () => {
    const icon = DETAIL_LAYERS.find(l => l.id === 'ad-reporting-point-icon')!
    expect(icon.group).toBe('reportingPoints')
    expect(icon.layout?.['icon-image']).toBe('wp-rp')
    expect(JSON.stringify(DETAIL_LAYERS.find(l => l.id === 'ad-details-point')!.filter)).toContain('reporting_point')      // not the plain dot as well
    expect(JSON.stringify(DETAIL_LAYERS.find(l => l.id === 'ad-details-label')!.filter)).toContain('reporting_point')
    expect(DETAIL_LAYERS.find(l => l.id === 'ad-reporting-point-label')!.group).toBe('reportingPoints')
    expect(staticColorLayers().some(l => l.id === 'ad-reporting-point-icon')).toBe(true)                                  // native keeps it
  })
})

describe('area labels on the map', () => {
  const area = (name: string | null, pending: boolean) => ({
    type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[[13, 55], [13.01, 55], [13.01, 55.01], [13, 55]]] },
    properties: { aerodrome: 'ESXX', kind: 'noise_sensitive' as const, name, remarks: null, floor: null, ceiling: null,
      approximate: true, accuracy_m: 86, pending },
  })
  it('an unnamed area has no label at all, not even "(unreviewed)" on its own', () => {
    const [f] = buildDetailsMapData([area(null, true)], []).features
    expect(f!.properties.label).toBe('')
  })
  it('a named, unreviewed area says its name and that it is unreviewed', () => {
    const [f] = buildDetailsMapData([area('Kastberga', true)], []).features
    expect(f!.properties.label).toBe('Kastberga\n(unreviewed)')
    expect(buildDetailsMapData([area('Kastberga', false)], []).features[0]!.properties.label).toBe('Kastberga')
  })
})

describe('reporting point labels and landmark labels', () => {
  const pt = (name: string, over: Record<string, unknown> = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [13, 55] },
    properties: { kind: 'reporting_point', name, aerodrome: 'ESTT', on_landmark: true, ...over } }) as never
  it('names of landmarks a drawn point sits on: only relevant aerodromes, only when the layer is on', () => {
    const fc = { features: [pt('Rängs kyrka'), pt('Elsewhere', { aerodrome: 'ESMI' }), pt('Free', { on_landmark: false })] }
    expect(landmarkNamesTakenByPoints(fc, ['ESTT'], true)).toEqual(['Rängs kyrka'])
    expect(landmarkNamesTakenByPoints(fc, [], true)).toEqual([])
    expect(landmarkNamesTakenByPoints(fc, ['ESTT'], false)).toEqual([])
    expect(landmarkNamesTakenByPoints(null, ['ESTT'], true)).toEqual([])
  })
  it('the landmark label filter drops only the taken names', () => {
    const base = ['!=', ['get', 'name'], ''] as never
    expect(landmarkLabelFilter(base, [])).toEqual(base)
    expect(landmarkLabelFilter(base, ['Rängs kyrka'])).toEqual(['all', base, ['!', ['in', ['get', 'name'], ['literal', ['Rängs kyrka']]]]])
  })
  it('the point label always looks for room: variable anchors, no fixed spot, and it is not left off for a landmark', () => {
    const l = DETAIL_LAYERS.find(x => x.id === 'ad-reporting-point-label')!
    expect((l.layout as Record<string, unknown>)['text-variable-anchor']).toEqual(LABEL_ANCHORS)
    expect((l.layout as Record<string, unknown>)['text-anchor']).toBeUndefined()
    expect(JSON.stringify(l.filter)).not.toContain('on_landmark')
  })
})

describe('direction marks for a loop flown both ways', () => {
  const spec = DETAIL_LAYERS.find(l => l.id === 'ad-circuit-dirmarks')!

  it('are hidden until a runway end is chosen, then shown for that end at that aerodrome only', () => {
    expect(JSON.stringify(layerFilter(spec, null))).toContain('hidden-until-a-runway-end-is-chosen')
    const f = JSON.stringify(layerFilter(spec, { aerodrome: 'ESTT', runway: '03' }))
    expect(f).toContain('"ESTT"')
    expect(f).toContain('|03|')
    expect(f).not.toContain('hidden-until-a-runway-end-is-chosen')
    // every comparison in these filters has an expression as its first operand (the new filter syntax), never two plain values
    const bare = (x: unknown): boolean => Array.isArray(x) && ((x[0] === '==' && x.length === 3 && !Array.isArray(x[1])) || x.some(bare))
    expect(bare(layerFilter(spec, null))).toBe(false)
    expect(bare(layerFilter(spec, { aerodrome: 'ESTT', runway: '03' }))).toBe(false)
  })

  it('no other circuit layer draws a direction feature (they are schematic) and the map data carries them', () => {
    const others = DETAIL_LAYERS.filter(l => l.group === 'circuits' && l.id !== 'ad-circuit-dirmarks' && l.id !== 'ad-circuit-turn' && l.id !== 'ad-circuit-turn-label')
    for (const l of others) expect(JSON.stringify(l.filter)).toContain('"schematic"')
    const fc = buildDetailsMapData([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[13, 55], [13.1, 55], [13.1, 55.1], [13, 55.1], [13, 55]] },
      properties: { aerodrome: 'ESTT', kind: 'circuit_leg', name: 'RWY 03 RH · RWY 21 LH', remarks: null, floor: null, ceiling: null, approximate: true, accuracy_m: null, pending: false } as never }], [])
    expect(fc.features.filter(f => f.properties.role === 'dir')).toHaveLength(2)
    expect(fc.features).toHaveLength(3)
    // an older published file marked this loop one-way: the map data overrides it, so no one-way marks are drawn for it
    const old = buildDetailsMapData([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[13, 55], [13.1, 55], [13.1, 55.1], [13, 55.1], [13, 55]] },
      properties: { aerodrome: 'ESTT', kind: 'circuit_leg', name: 'RWY 03 RH · RWY 21 LH', oneWay: true, remarks: null, floor: null, ceiling: null, approximate: true, accuracy_m: null, pending: false } as never }], [])
    expect(old.features.find(f => f.properties.role !== 'dir')!.properties.oneWay).toBe(false)
  })
})

describe('direction marks on the per-group (native) layers', () => {
  it('are hidden until a runway end is chosen, on every group layer', () => {
    const dm = staticColorLayers().filter(l => l.id.startsWith('ad-circuit-dirmarks'))
    expect(dm.length).toBeGreaterThan(1)
    for (const l of dm) {
      expect(JSON.stringify(layerFilter(l, null))).toContain('hidden-until-a-runway-end-is-chosen')
      expect(JSON.stringify(layerFilter(l, { aerodrome: 'ESMI', runway: '12' }))).not.toContain('hidden-until-a-runway-end-is-chosen')
    }
  })
})
