/**
 * How the experimental aerodrome details look on the map, shared by web (AerodromeDetailsLayer.tsx, imperative
 * maplibre-gl) and native (AviationMap.tsx, declarative MapLibre React Native). The two only differ in how they feed
 * the layers to the renderer; the data built for the map, the layers, their filters, zoom steps and colours, and the
 * runway focus are defined here once.
 *
 * Layer groups (each has its own switch): 'circuits' (drawn legs, turn arrows, chevrons, labels: "Traffic circuits"),
 * 'holdings' (orbit direction at holding points: "Holding points"), 'details' (areas, taxiways, extra reporting
 * points: always on with the experiment).
 */
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import {
  AREA_KINDS, CIRCUIT_GROUPS, CIRCUIT_GROUP_COLOR, DETAIL_KIND_COLOR, formatLimits, holdingOrbitFeatures, schematicCircuitFeatures,
  type DetailKind, type DetailProps,
} from './aerodromeDetails'

/** A MapLibre expression (typed loosely: this package depends on neither renderer). */
export type Expr = readonly unknown[]

export interface DetailLayerSpec {
  id: string
  type: 'fill' | 'line' | 'symbol' | 'circle'
  group: 'circuits' | 'holdings' | 'details'
  minzoom: number
  filter: Expr
  layout?: Record<string, unknown>
  paint: Record<string, unknown>
}

export interface CircuitFocus { aerodrome: string; runway: string }

// Circuits gain detail with zoom: drawn legs from 9.5 (thin), direction from 10.5, runway labels from 11.5.
export const DETAILS_MIN_ZOOM = 9
export const CIRCUIT_ZOOM = 9.5
export const DIRECTION_ZOOM = 10.5
export const LABEL_ZOOM = 11.5
const FONT = ['Noto Sans Regular']
// Circuit labels name the runway and side ("06 RH · 24 LH"): dark text on a wide white halo, readable on any base
// map, unlike the line colour itself.
const CIRCUIT_LABEL_FONT = ['Noto Sans Medium']
const CIRCUIT_LABEL_COLOR = '#0c4a6e'
const AREA_LABEL_COLOR = '#1f2937'
const CIRCUIT_LABEL_SIZE: Expr = ['interpolate', ['linear'], ['zoom'], 11.5, 12, 14, 14]
const CIRCUIT_WIDTH: Expr = ['interpolate', ['linear'], ['zoom'], 9.5, 1, 12, 2.5, 15, 3.5]
const HALO = 'rgba(255,255,255,0.92)'

const COLOR: Expr = ['match', ['get', 'kind'],
  ...Object.entries(DETAIL_KIND_COLOR).flatMap(([k, c]) => [k, c]), DETAIL_KIND_COLOR.other]
// Circuits are coloured by the aircraft group they are for (a club map draws powered, glider and ultralight circuits
// in different colours); no group = everyone = the powered colour.
const CIRCUIT_COLOR: Expr = ['match', ['get', 'aircraft'],
  ...CIRCUIT_GROUPS.filter(g => g !== 'powered').flatMap(g => [g, CIRCUIT_GROUP_COLOR[g]]), CIRCUIT_GROUP_COLOR.powered]
const DASHED: Expr = ['any', ['get', 'approximate'], ['get', 'pending']]
const IS_AREA: Expr = ['in', ['get', 'kind'], ['literal', [...AREA_KINDS]]]
const IS_CIRCUIT: Expr = ['==', ['get', 'kind'], 'circuit_leg']
const NOT_CIRCUIT: Expr = ['!=', ['get', 'kind'], 'circuit_leg']
const IS_HOLDING: Expr = ['==', ['get', 'kind'], 'holding']
const LINE: Expr = ['==', ['geometry-type'], 'LineString']
const POLY: Expr = ['==', ['geometry-type'], 'Polygon']
const POINT: Expr = ['==', ['geometry-type'], 'Point']
const DRAWN: Expr = ['!=', ['get', 'schematic'], true]

/** Layers in drawing order (bottom first). */
export const DETAIL_LAYERS: readonly DetailLayerSpec[] = [
  // Areas, taxiways, parking, extra reporting points
  { id: 'ad-details-fill', type: 'fill', group: 'details', minzoom: DETAILS_MIN_ZOOM, filter: ['all', POLY, IS_AREA],
    paint: { 'fill-color': COLOR, 'fill-opacity': ['case', ['get', 'pending'], 0.08, 0.16] } },
  { id: 'ad-details-outline', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM, filter: ['all', POLY, ['!', DASHED]],
    paint: { 'line-color': COLOR, 'line-width': 1.8 } },
  { id: 'ad-details-outline-dashed', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM, filter: ['all', POLY, DASHED],
    paint: { 'line-color': COLOR, 'line-width': 1.8, 'line-dasharray': [3, 2] } },
  { id: 'ad-details-line', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM,
    filter: ['all', LINE, NOT_CIRCUIT, ['!', IS_HOLDING], ['!', DASHED]],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 1.8 } },
  { id: 'ad-details-line-dashed', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM,
    filter: ['all', LINE, NOT_CIRCUIT, ['!', IS_HOLDING], DASHED],
    layout: { 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 1.8, 'line-dasharray': [2, 2] } },
  // Circuits ("Traffic circuits")
  { id: 'ad-circuit-line', type: 'line', group: 'circuits', minzoom: CIRCUIT_ZOOM, filter: ['all', LINE, IS_CIRCUIT, DRAWN, ['!', DASHED]],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': CIRCUIT_COLOR, 'line-width': CIRCUIT_WIDTH } },
  { id: 'ad-circuit-line-dashed', type: 'line', group: 'circuits', minzoom: CIRCUIT_ZOOM, filter: ['all', LINE, IS_CIRCUIT, DRAWN, DASHED],
    layout: { 'line-join': 'round' }, paint: { 'line-color': CIRCUIT_COLOR, 'line-width': CIRCUIT_WIDTH, 'line-dasharray': [2, 2] } },
  // A circuit known only by its direction: "after take-off, turn left/right". Lighter while unreviewed.
  { id: 'ad-circuit-turn', type: 'line', group: 'circuits', minzoom: DIRECTION_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, ['==', ['get', 'role'], 'turn']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': CIRCUIT_COLOR, 'line-width': CIRCUIT_WIDTH, 'line-opacity': ['case', ['get', 'pending'], 0.7, 1] } },
  // chevrons along drawn legs, unless the pattern is flown both ways (its label names both runway directions)
  { id: 'ad-circuit-chevrons', type: 'symbol', group: 'circuits', minzoom: DIRECTION_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, DRAWN, ['!=', ['get', 'oneWay'], false]],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '>', 'text-font': FONT, 'text-size': 14,
      'text-keep-upright': false, 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': CIRCUIT_COLOR, 'text-halo-color': 'rgba(0,0,0,0.6)', 'text-halo-width': 1 } },
  { id: 'ad-circuit-label', type: 'symbol', group: 'circuits', minzoom: LABEL_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, DRAWN, ['!=', ['get', 'clabel'], '']],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 260, 'text-field': ['get', 'clabel'], 'text-font': CIRCUIT_LABEL_FONT,
      'text-size': CIRCUIT_LABEL_SIZE, 'text-offset': [0, -1], 'text-keep-upright': true, 'text-max-angle': 30 },
    paint: { 'text-color': CIRCUIT_LABEL_COLOR, 'text-halo-color': HALO, 'text-halo-width': 2.4, 'text-halo-blur': 0.3 } },
  { id: 'ad-circuit-turn-label', type: 'symbol', group: 'circuits', minzoom: LABEL_ZOOM,
    filter: ['all', POINT, IS_CIRCUIT, ['==', ['get', 'role'], 'label']],
    layout: { 'text-field': ['get', 'clabel'], 'text-font': CIRCUIT_LABEL_FONT, 'text-size': CIRCUIT_LABEL_SIZE,
      'text-anchor': 'center' },
    paint: { 'text-color': CIRCUIT_LABEL_COLOR, 'text-halo-color': HALO, 'text-halo-width': 2.4, 'text-halo-blur': 0.3 } },
  // Orbit flown at a holding point, around the base layer's holding symbol ("Holding points")
  { id: 'ad-holding-orbit', type: 'line', group: 'holdings', minzoom: 10, filter: ['all', LINE, IS_HOLDING],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 13, 2.2],
      'line-opacity': ['case', ['get', 'pending'], 0.7, 1] } },
  // Extra reporting points and labels of areas and points (holding points: the base layer draws symbol and name)
  { id: 'ad-details-point', type: 'circle', group: 'details', minzoom: DETAILS_MIN_ZOOM,
    filter: ['all', POINT, NOT_CIRCUIT, ['!', IS_HOLDING]],
    paint: { 'circle-radius': 4, 'circle-color': COLOR, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2,
      'circle-opacity': ['case', ['get', 'pending'], 0.6, 1] } },
  { id: 'ad-details-label', type: 'symbol', group: 'details', minzoom: 10, filter: ['!=', ['get', 'label'], ''],
    layout: { 'text-field': ['get', 'label'], 'text-font': CIRCUIT_LABEL_FONT, 'text-size': 12, 'text-max-width': 12,
      'text-offset': ['case', ['==', ['geometry-type'], 'Point'], ['literal', [0, 1.1]], ['literal', [0, 0]]],
      'text-anchor': ['case', ['==', ['geometry-type'], 'Point'], 'top', 'center'] },
    // Dark text on a wide white halo, as the circuit labels: the kind colours (amber, green) vanish on the base map.
    paint: { 'text-color': AREA_LABEL_COLOR, 'text-halo-color': HALO, 'text-halo-width': 2.4, 'text-halo-blur': 0.3 } },
]

const KINDS_OF_GROUP: Record<DetailLayerSpec['group'], DetailKind[]> = {
  circuits: ['circuit_leg'],
  holdings: ['holding'],
  details: (Object.keys(DETAIL_KIND_COLOR) as DetailKind[]).filter(k => k !== 'circuit_leg' && k !== 'holding'),
}

/**
 * The layers with fixed colours: every layer that colours by kind becomes one layer per kind
 * ("ad-details-fill-noise_sensitive", ...). For MapLibre Native on iOS, which aborts at style load when a colour
 * property is computed from feature properties on a GeoJSON layer.
 */
export function staticColorLayers(specs: readonly DetailLayerSpec[] = DETAIL_LAYERS): DetailLayerSpec[] {
  return specs.flatMap((l) => {
    const groupKeys = [...Object.keys(l.paint)].filter(k => l.paint[k] === CIRCUIT_COLOR)
    if (groupKeys.length) {
      const special = CIRCUIT_GROUPS.filter(g => g !== 'powered')
      return CIRCUIT_GROUPS.map(g => ({
        ...l,
        id: `${l.id}-${g}`,
        filter: ['all', l.filter, g === 'powered' ? ['!', ['in', ['get', 'aircraft'], ['literal', special]]]
          : ['==', ['get', 'aircraft'], g]] as Expr,
        paint: { ...l.paint, ...Object.fromEntries(groupKeys.map(k => [k, CIRCUIT_GROUP_COLOR[g]])) },
      }))
    }
    const keys = [...Object.keys(l.paint)].filter(k => l.paint[k] === COLOR)
    if (!keys.length) return [l]
    return KINDS_OF_GROUP[l.group].map(kind => ({
      ...l,
      id: `${l.id}-${kind}`,
      filter: ['all', l.filter, ['==', ['get', 'kind'], kind]] as Expr,
      paint: { ...l.paint, ...Object.fromEntries(keys.map(k => [k, DETAIL_KIND_COLOR[kind]])) },
    }))
  })
}

export const CIRCUIT_LAYER_IDS = DETAIL_LAYERS.filter(l => l.group === 'circuits').map(l => l.id)
export const HOLDING_ORBIT_LAYER = 'ad-holding-orbit'

/** A circuit layer's filter with the runway focus: at the focused aerodrome only circuits for that runway end
 *  (circuits without known runways, such as drawn club legs, stay). Other layers are returned unchanged. */
export function layerFilter(l: DetailLayerSpec, focus: CircuitFocus | null): Expr {
  if (!focus || l.group !== 'circuits') return l.filter
  return ['all', l.filter, ['any', ['!=', ['get', 'aerodrome'], focus.aerodrome], ['!', ['has', 'rwys']],
    ['in', `|${focus.runway}|`, ['get', 'rwys']]]]
}

const idOf = (f: Feature): string | null => {
  const p = (f.properties ?? {}) as Record<string, unknown>
  return (typeof p['icao'] === 'string' && p['icao']) || (typeof p['local_id'] === 'string' && p['local_id']) || null
}

/**
 * Everything the map draws: the details file, turn arrows for aerodromes whose circuits are known only by direction,
 * orbits at holding points with a direction, plus the `label` text of areas and points (MapLibre can't format the
 * nested limits).
 */
export function buildDetailsMapData(
  details: readonly Feature<Geometry, DetailProps>[],
  aerodromes: readonly Feature[],
): FeatureCollection<Geometry, DetailProps & { label: string; clabel: string }> {
  const drawn = new Set(details.filter(f => f.properties.kind === 'circuit_leg' && f.geometry.type === 'LineString')
    .map(f => f.properties.aerodrome))
  const all = [...details, ...schematicCircuitFeatures(aerodromes, drawn), ...holdingOrbitFeatures(details)]
  return {
    type: 'FeatureCollection',
    features: all.map(f => ({
      ...f,
      properties: {
        ...f.properties,
        label: f.properties.kind !== 'circuit_leg' && f.properties.kind !== 'holding'
          && (f.geometry.type === 'Point' || AREA_KINDS.has(f.properties.kind as DetailKind))
          ? [mapAreaLabel(f.properties), f.properties.pending ? '(unreviewed)' : null].filter(Boolean).join('\n')
          : '',
        clabel: f.properties.kind === 'circuit_leg' ? circuitLabel(f.properties.name) : '',
      },
    })),
  }
}

// What an area is, in English, in front of a place name taken from the source ("Central Västerås" alone says nothing).
const AREA_KIND_LABEL: Partial<Record<string, string>> = {
  noise_sensitive: 'Noise-sensitive area', avoid_area: 'Avoid area', glider_area: 'Glider area',
  parachute_area: 'Parachute area', model_area: 'Model aircraft area',
}

/** Map label of an area or point: its kind in English, then the name and vertical limits. */
export function mapAreaLabel(p: Pick<DetailProps, 'kind' | 'name' | 'floor' | 'ceiling'>): string {
  const kind = AREA_KIND_LABEL[p.kind]
  const name = p.name?.trim() ?? ''
  const head = kind && name && !name.toLowerCase().includes(kind.toLowerCase().split(' ')[0]!) ? `${kind}: ${name}` : (name || kind || '')
  return [head, formatLimits(p.floor, p.ceiling)].filter(Boolean).join('\n')
}

/** Map label of a circuit, short so it fits along the line: "RWY 06 RH · RWY 24 LH" -> "06 RH · 24 LH",
 *  "ESMI UL-landningsvarv" -> "UL-landningsvarv". */
export function circuitLabel(name: string | null): string {
  return (name ?? '').replace(/^[A-Z]{4}\s+/, '').replace(/\bRWY\s*/gi, '').trim()
}

export { idOf as aerodromeIdOf }
