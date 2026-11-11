import { describe, it, expect } from 'vitest'
import { DETAIL_LAYERS, staticColorLayers, layerFilter, buildDetailsMapData, circuitLabel, CIRCUIT_LAYER_IDS } from './aerodromeDetailsStyle'
import { DETAIL_KIND_COLOR } from './aerodromeDetails'

describe('aerodromeDetailsStyle', () => {
  it('static-colour layers never compute a colour from feature properties', () => {
    const layers = staticColorLayers()
    const colourKeys = (p: Record<string, unknown>) => Object.entries(p).filter(([k]) => /-color$/.test(k))
    for (const l of layers) for (const [, v] of colourKeys(l.paint)) expect(typeof v).toBe('string')
    expect(layers.find(l => l.id === 'ad-circuit-turn-circuit_leg')!.paint['line-color']).toBe(DETAIL_KIND_COLOR.circuit_leg)
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
    // labels are dark on a white halo, never the (light) line colour
    for (const id of ['ad-circuit-label', 'ad-circuit-turn-label']) {
      expect(DETAIL_LAYERS.find(l => l.id === id)!.paint['text-color']).toBe('#0c4a6e')
    }
  })
})
