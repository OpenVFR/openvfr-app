/**
 * Aerodrome details on the map (experimental, EXPERIMENTAL_AERODROME_DETAILS):
 * noise-sensitive and other areas (fill + outline, name and heights), extra
 * reporting points, taxiways and parking from 9 up; circuits in steps (drawn
 * legs from 9.5, direction from 10.5, runway labels from 11.5). A circuit
 * known only by its direction is a turn arrow at the departure end, never an
 * invented pattern. Circuits have their own Layers-panel switch and follow the
 * runway end tapped in the aerodrome popup. Dashed: outlines read off a chart
 * (approximate) and unreviewed values in a local preview build.
 * Added with the runtime API only, below the airspace layers.
 */
import { useEffect } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { areaLabel, AREA_KINDS, DETAIL_KIND_COLOR, type DetailKind } from '@open-vfr/shared/aerodromeDetails'
import { useAerodromeDetailsLayer, useCircuitFocus, type CircuitFocus } from '../utils/aerodromeDetails'
import { CIRCUIT_LAYER_IDS } from '../styles/map-style'

const SOURCE = 'aerodrome-details'
const BELOW_LAYERS = ['airspace-fill-g', 'navaids-vor-icon', 'aerodromes-atc-ring']
const MIN_ZOOM = 9
const FONT = ['Noto Sans Regular']
// Circuits gain detail with zoom: lines from 9.5 (thin), direction from 10.5, runway labels from 11.5.
const CIRCUIT_ZOOM = 9.5
const DIRECTION_ZOOM = 10.5
const LABEL_ZOOM = 11.5
const CIRCUIT_WIDTH: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 9.5, 1, 12, 2.5, 15, 3.5]

type Filter = maplibregl.ExpressionSpecification
const COLOR: maplibregl.ExpressionSpecification = ['match', ['get', 'kind'],
  ...Object.entries(DETAIL_KIND_COLOR).flatMap(([k, c]) => [k, c]), DETAIL_KIND_COLOR.other] as unknown as maplibregl.ExpressionSpecification
const DASHED: maplibregl.ExpressionSpecification = ['any', ['get', 'approximate'], ['get', 'pending']]
const IS_AREA: maplibregl.ExpressionSpecification = ['in', ['get', 'kind'], ['literal', [...AREA_KINDS]]]
const IS_CIRCUIT: Filter = ['==', ['get', 'kind'], 'circuit_leg']
const NOT_CIRCUIT: Filter = ['!=', ['get', 'kind'], 'circuit_leg']
const LINE: Filter = ['==', ['geometry-type'], 'LineString']
const POLY: Filter = ['==', ['geometry-type'], 'Polygon']
const POINT: Filter = ['==', ['geometry-type'], 'Point']
const DRAWN: Filter = ['!=', ['get', 'schematic'], true]

// Circuit layers and their filters before the runway focus is applied.
const CIRCUIT_FILTERS: Record<(typeof CIRCUIT_LAYER_IDS)[number], Filter> = {
  'ad-circuit-line': ['all', LINE, IS_CIRCUIT, DRAWN, ['!', DASHED]],
  'ad-circuit-line-dashed': ['all', LINE, IS_CIRCUIT, DRAWN, DASHED],
  'ad-circuit-turn': ['all', LINE, IS_CIRCUIT, ['==', ['get', 'role'], 'turn']],
  'ad-circuit-chevrons': ['all', LINE, IS_CIRCUIT, DRAWN],
  'ad-circuit-label': ['all', LINE, IS_CIRCUIT, DRAWN, ['has', 'name']],
  'ad-circuit-turn-label': ['all', POINT, IS_CIRCUIT, ['==', ['get', 'role'], 'label']],
}
const OTHER_LAYERS = ['ad-details-fill', 'ad-details-outline', 'ad-details-outline-dashed', 'ad-details-line',
  'ad-details-line-dashed', 'ad-details-point', 'ad-details-label'] as const

/** A circuit layer's filter with the runway focus: at the focused aerodrome only circuits for that runway end
 *  (circuits without known runways, such as drawn club legs, stay). */
function focused(base: Filter, f: CircuitFocus | null): Filter {
  if (!f) return base
  return ['all', base, ['any', ['!=', ['get', 'aerodrome'], f.aerodrome], ['!', ['has', 'rwys']],
    ['in', `|${f.runway}|`, ['get', 'rwys']]]]
}

function remove(map: maplibregl.Map) {
  for (const id of [...CIRCUIT_LAYER_IDS, ...OTHER_LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(SOURCE)) map.removeSource(SOURCE)
}

function applyCircuits(map: maplibregl.Map, visible: boolean, f: CircuitFocus | null) {
  for (const id of CIRCUIT_LAYER_IDS) {
    if (!map.getLayer(id)) continue
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    map.setFilter(id, focused(CIRCUIT_FILTERS[id], f))
  }
}

export default function AerodromeDetailsLayer({ map, circuitsVisible }: { map: maplibregl.Map | null; circuitsVisible: boolean }) {
  const fc = useAerodromeDetailsLayer(!!map)
  const focus = useCircuitFocus()

  useEffect(() => {
    if (!map || !fc) return
    // Labels are computed here (MapLibre can't format the nested limits).
    const data = {
      ...fc,
      features: fc.features.map(f => ({
        ...f,
        properties: {
          ...f.properties,
          label: f.properties.kind !== 'circuit_leg' && (f.geometry.type === 'Point' || AREA_KINDS.has(f.properties.kind as DetailKind))
            ? [areaLabel(f.properties), f.properties.pending ? '(unreviewed)' : null].filter(Boolean).join('\n')
            : '',
        },
      })),
    }
    const src = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
    if (src) { src.setData(data as GeoJSON.FeatureCollection); return }
    const before = BELOW_LAYERS.find(id => map.getLayer(id))
    map.addSource(SOURCE, { type: 'geojson', data: data as GeoJSON.FeatureCollection })
    // Areas, taxiways, parking, extra reporting points
    map.addLayer({ id: 'ad-details-fill', type: 'fill', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', POLY, IS_AREA],
      paint: { 'fill-color': COLOR, 'fill-opacity': ['case', ['get', 'pending'], 0.08, 0.16] } }, before)
    map.addLayer({ id: 'ad-details-outline', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', POLY, ['!', DASHED]],
      paint: { 'line-color': COLOR, 'line-width': 1.8 } }, before)
    map.addLayer({ id: 'ad-details-outline-dashed', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', POLY, DASHED],
      paint: { 'line-color': COLOR, 'line-width': 1.8, 'line-dasharray': [3, 2] } }, before)
    map.addLayer({ id: 'ad-details-line', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', LINE, NOT_CIRCUIT, ['!', DASHED]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': 1.8 } }, before)
    map.addLayer({ id: 'ad-details-line-dashed', type: 'line', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', LINE, NOT_CIRCUIT, DASHED],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': 1.8, 'line-dasharray': [2, 2] } }, before)
    // Circuits ("Traffic circuits" in the Layers panel): drawn legs from 9.5, turn arrows and chevrons from 10.5,
    // runway labels from 11.5.
    map.addLayer({ id: 'ad-circuit-line', type: 'line', source: SOURCE, minzoom: CIRCUIT_ZOOM,
      filter: CIRCUIT_FILTERS['ad-circuit-line'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': CIRCUIT_WIDTH } }, before)
    map.addLayer({ id: 'ad-circuit-line-dashed', type: 'line', source: SOURCE, minzoom: CIRCUIT_ZOOM,
      filter: CIRCUIT_FILTERS['ad-circuit-line-dashed'], layout: { 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': CIRCUIT_WIDTH, 'line-dasharray': [2, 2] } }, before)
    // A circuit known only by its direction: "after take-off, turn left/right". Lighter while unreviewed.
    map.addLayer({ id: 'ad-circuit-turn', type: 'line', source: SOURCE, minzoom: DIRECTION_ZOOM,
      filter: CIRCUIT_FILTERS['ad-circuit-turn'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': CIRCUIT_WIDTH, 'line-opacity': ['case', ['get', 'pending'], 0.7, 1] } }, before)
    map.addLayer({ id: 'ad-circuit-chevrons', type: 'symbol', source: SOURCE, minzoom: DIRECTION_ZOOM,
      filter: CIRCUIT_FILTERS['ad-circuit-chevrons'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '>', 'text-font': FONT, 'text-size': 14,
        'text-keep-upright': false, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(0,0,0,0.6)', 'text-halo-width': 1 } }, before)
    map.addLayer({ id: 'ad-circuit-label', type: 'symbol', source: SOURCE, minzoom: LABEL_ZOOM,
      filter: CIRCUIT_FILTERS['ad-circuit-label'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 260, 'text-field': ['get', 'name'], 'text-font': FONT,
        'text-size': 11, 'text-offset': [0, -0.9], 'text-keep-upright': true, 'text-max-angle': 30 },
      paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.6 } }, before)
    map.addLayer({ id: 'ad-circuit-turn-label', type: 'symbol', source: SOURCE, minzoom: LABEL_ZOOM,
      filter: CIRCUIT_FILTERS['ad-circuit-turn-label'],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-anchor': 'center' },
      paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.6 } }, before)
    map.addLayer({ id: 'ad-details-point', type: 'circle', source: SOURCE, minzoom: MIN_ZOOM,
      filter: ['all', POINT, NOT_CIRCUIT],
      paint: { 'circle-radius': 4, 'circle-color': COLOR, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2,
        'circle-opacity': ['case', ['get', 'pending'], 0.6, 1] } }, before)
    map.addLayer({ id: 'ad-details-label', type: 'symbol', source: SOURCE, minzoom: 10,
      filter: ['!=', ['get', 'label'], ''],
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-max-width': 12,
        'text-offset': ['case', ['==', ['geometry-type'], 'Point'], ['literal', [0, 1.1]], ['literal', [0, 0]]],
        'text-anchor': ['case', ['==', ['geometry-type'], 'Point'], 'top', 'center'] },
      paint: { 'text-color': COLOR, 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.6 } }, before)
  }, [map, fc])

  // Layers-panel switch and runway focus; also right after the layers are first added.
  useEffect(() => { if (map && fc) applyCircuits(map, circuitsVisible, focus) }, [map, fc, circuitsVisible, focus])

  useEffect(() => () => { if (map) remove(map) }, [map])

  return null
}
