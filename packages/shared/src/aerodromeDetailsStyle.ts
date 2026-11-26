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
  AREA_KINDS, CIRCUIT_GROUPS, CIRCUIT_GROUP_COLOR, DETAIL_KIND_COLOR, directionFeatures, isBothWaysLoop, formatLimit, formatLimits, holdingOrbitFeatures, schematicCircuitFeatures,
  type DetailFeature, type DetailKind, type DetailProps,
} from './aerodromeDetails'
import { RUNWAY_COLORS } from './featureColors'

/** A MapLibre expression (typed loosely: this package depends on neither renderer). */
export type Expr = readonly unknown[]

export interface DetailLayerSpec {
  id: string
  type: 'fill' | 'line' | 'symbol' | 'circle'
  group: 'circuits' | 'holdings' | 'reportingPoints' | 'details'
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
// A circuit for gliders, ultralights, helicopters or gyros is drawn thinner than the one for ordinary powered aircraft, so the main one stands out where several overlap.
const ARRIVAL: Expr = ['==', ['get', 'kind'], 'arrival_route']
// A fly-in route is the quietest line on the map: the circuit is what the pilot flies, the route only leads to it (thin like the secondary circuits, and fainter).
const SECONDARY: Expr = ['any', ARRIVAL, ['in', ['get', 'aircraft'], ['literal', ['glider', 'ultralight', 'helicopter', 'gyro']]]]
const ROUTE_FAINT: Expr = ['case', ARRIVAL, 0.55, 1]
const THIN = 0.7
const CIRCUIT_WIDTH: Expr = ['interpolate', ['linear'], ['zoom'],
  9.5, ['case', SECONDARY, 1 * THIN, 1], 12, ['case', SECONDARY, 2.5 * THIN, 2.5], 15, ['case', SECONDARY, 3.5 * THIN, 3.5]]
const HALO = 'rgba(255,255,255,0.92)'

const COLOR: Expr = ['match', ['get', 'kind'],
  ...Object.entries(DETAIL_KIND_COLOR).flatMap(([k, c]) => [k, c]), DETAIL_KIND_COLOR.other]
// Circuits are coloured by the aircraft group they are for (a club map draws powered, glider and ultralight circuits
// in different colours); no group = everyone = the powered colour.
// A fly-in route is not a circuit: it has its own colour whatever it is for (pink, DETAIL_KIND_COLOR.arrival_route).
const CIRCUIT_COLOR: Expr = ['case', ARRIVAL, DETAIL_KIND_COLOR.arrival_route, ['match', ['get', 'aircraft'],
  ...CIRCUIT_GROUPS.filter(g => g !== 'powered').flatMap(g => [g, CIRCUIT_GROUP_COLOR[g]]), CIRCUIT_GROUP_COLOR.powered]]
const DASHED: Expr = ['any', ['get', 'approximate'], ['get', 'pending']]
const IS_AREA: Expr = ['in', ['get', 'kind'], ['literal', [...AREA_KINDS]]]
// An arrival route (the fly-in drawn on a club map) is drawn, labelled, switched and focused like a circuit
const IS_CIRCUIT: Expr = ['in', ['get', 'kind'], ['literal', ['circuit_leg', 'arrival_route']]]
const NOT_CIRCUIT: Expr = ['!', ['in', ['get', 'kind'], ['literal', ['circuit_leg', 'arrival_route']]]]
const IS_RUNWAY: Expr = ['==', ['get', 'kind'], 'runway']
const IS_HOLDING: Expr = ['==', ['get', 'kind'], 'holding']
const IS_RP: Expr = ['==', ['get', 'kind'], 'reporting_point']
const LINE: Expr = ['==', ['geometry-type'], 'LineString']
const POLY: Expr = ['==', ['geometry-type'], 'Polygon']
const POINT: Expr = ['==', ['geometry-type'], 'Point']
const DRAWN: Expr = ['!=', ['get', 'schematic'], true]

/** The sides a label tries, in order, round its symbol. */
export const LABEL_ANCHORS: ('top' | 'bottom' | 'right' | 'left' | 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left')[] = ['top', 'bottom', 'right', 'left', 'top-right', 'bottom-right', 'top-left', 'bottom-left']

/** Layers in drawing order (bottom first). */
export const DETAIL_LAYERS: readonly DetailLayerSpec[] = [
  // A runway the official data lacks (a parallel glider strip): drawn like the base layer's runways, under everything else of the details
  { id: 'ad-runway-outline', type: 'line', group: 'details', minzoom: 11, filter: ['all', LINE, IS_RUNWAY], layout: { 'line-cap': 'butt' },
    paint: { 'line-color': RUNWAY_COLORS.outline, 'line-width': ['interpolate', ['exponential', 2], ['zoom'],
      11, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 1.5], 14, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 7], 17, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 32]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 0.9] } },
  // two layers by surface, each with a fixed colour (a colour computed from a feature property is refused by the iOS native renderer)
  { id: 'ad-runway-line-paved', type: 'line', group: 'details', minzoom: 11, filter: ['all', LINE, IS_RUNWAY, ['in', ['get', 'surface'], ['literal', ['ASPH', 'CONC']]]], layout: { 'line-cap': 'butt' },
    paint: { 'line-color': RUNWAY_COLORS.asphalt,
      'line-width': ['interpolate', ['exponential', 2], ['zoom'],
        11, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 1], 14, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 5], 17, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 24]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1] } },
  { id: 'ad-runway-line', type: 'line', group: 'details', minzoom: 11, filter: ['all', LINE, IS_RUNWAY, ['!', ['in', ['get', 'surface'], ['literal', ['ASPH', 'CONC']]]]], layout: { 'line-cap': 'butt' },
    paint: { 'line-color': RUNWAY_COLORS.grass,
      'line-width': ['interpolate', ['exponential', 2], ['zoom'],
        11, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 1], 14, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 5], 17, ['*', ['/', ['coalesce', ['get', 'width_m'], 30], 30], 24]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1] } },
  { id: 'ad-runway-end', type: 'symbol', group: 'details', minzoom: 12, filter: ['all', POINT, IS_RUNWAY],
    layout: { 'text-field': ['get', 'end'], 'text-font': ['Noto Sans Medium'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 14],
      'text-rotate': ['coalesce', ['get', 'brg'], 0], 'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#333840', 'text-halo-width': 1.4, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 1] } },
  // Areas, taxiways, parking, extra reporting points
  { id: 'ad-details-fill', type: 'fill', group: 'details', minzoom: DETAILS_MIN_ZOOM, filter: ['all', POLY, IS_AREA],
    paint: { 'fill-color': COLOR, 'fill-opacity': ['case', ['get', 'pending'], 0.025, 0.05] } },       // a warning area, not a path: it must not outshout the circuits drawn over it
  { id: 'ad-details-outline', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM, filter: ['all', POLY, ['!', DASHED]],
    paint: { 'line-color': COLOR, 'line-width': 1.2 } },
  { id: 'ad-details-outline-dashed', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM, filter: ['all', POLY, DASHED],
    paint: { 'line-color': COLOR, 'line-width': 1.2, 'line-dasharray': [3, 2] } },
  { id: 'ad-details-line', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM,
    filter: ['all', LINE, NOT_CIRCUIT, ['!', IS_HOLDING], ['!', IS_RUNWAY], ['!', DASHED]],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 1.8 } },
  { id: 'ad-details-line-dashed', type: 'line', group: 'details', minzoom: DETAILS_MIN_ZOOM,
    filter: ['all', LINE, NOT_CIRCUIT, ['!', IS_HOLDING], ['!', IS_RUNWAY], DASHED],
    layout: { 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 1.8, 'line-dasharray': [2, 2] } },
  // Circuits ("Traffic circuits") are always dashed, so the runway, the roads and the other circuits show through the gaps where
  // several patterns overlap (a casing under them made a club field with three patterns unreadable). Exact, reviewed legs have
  // long dashes; an approximate or unreviewed one has shorter dashes with wider gaps and is fainter.
  { id: 'ad-circuit-line', type: 'line', group: 'circuits', minzoom: CIRCUIT_ZOOM, filter: ['all', LINE, IS_CIRCUIT, DRAWN, ['!', DASHED]],
    layout: { 'line-join': 'round' }, paint: { 'line-color': CIRCUIT_COLOR, 'line-width': CIRCUIT_WIDTH, 'line-dasharray': [3, 1.6], 'line-opacity': ROUTE_FAINT } },
  { id: 'ad-circuit-line-dashed', type: 'line', group: 'circuits', minzoom: CIRCUIT_ZOOM, filter: ['all', LINE, IS_CIRCUIT, DRAWN, DASHED],
    layout: { 'line-join': 'round' }, paint: { 'line-color': CIRCUIT_COLOR, 'line-width': CIRCUIT_WIDTH, 'line-dasharray': [2, 2.4], 'line-opacity': ['case', ARRIVAL, 0.5, 0.8] } },
  // A circuit known only by its direction: "after take-off, turn left/right". Lighter while unreviewed.
  { id: 'ad-circuit-turn', type: 'line', group: 'circuits', minzoom: DIRECTION_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, ['==', ['get', 'role'], 'turn']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    // orientation only (a direction, no surveyed path): visibly fainter than a drawn circuit
    paint: { 'line-color': CIRCUIT_COLOR, 'line-width': CIRCUIT_WIDTH, 'line-opacity': ['case', ['get', 'pending'], 0.45, 0.6] } },
  // chevrons along drawn legs, unless the pattern is flown both ways (its label names both runway directions)
  { id: 'ad-circuit-chevrons', type: 'symbol', group: 'circuits', minzoom: DIRECTION_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, DRAWN, ['!=', ['get', 'oneWay'], false]],
    // a few direction marks per leg, not a row: sparse when zoomed out, wider apart as the legs grow on screen, and smaller on the circuits for other aircraft groups
    layout: { 'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 10.5, 200, 13, 300, 16, 420],
      'text-field': '>', 'text-font': FONT, 'text-size': ['case', SECONDARY, 11, 13],
      'text-keep-upright': false, 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': CIRCUIT_COLOR, 'text-halo-color': 'rgba(0,0,0,0.6)', 'text-halo-width': 1 } },
  // The direction of a loop flown both ways, for the runway end chosen in the card: hidden until an end is chosen (layerFilter), then marks running the way that end flies it
  { id: 'ad-circuit-dirmarks', type: 'symbol', group: 'circuits', minzoom: DIRECTION_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, ['==', ['get', 'role'], 'dir']],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 10.5, 110, 13, 170, 16, 260],
      'text-field': '>', 'text-font': FONT, 'text-size': 15, 'text-keep-upright': false, 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': CIRCUIT_COLOR, 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.6 } },
  { id: 'ad-circuit-label', type: 'symbol', group: 'circuits', minzoom: LABEL_ZOOM,
    filter: ['all', LINE, IS_CIRCUIT, DRAWN, ['!=', ['get', 'clabel'], '']],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['get', 'clabel'], 'text-font': CIRCUIT_LABEL_FONT,
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
    filter: ['all', POINT, NOT_CIRCUIT, ['!', IS_HOLDING], ['!', IS_RP]],
    paint: { 'circle-radius': 4, 'circle-color': COLOR, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2,
      'circle-opacity': ['case', ['get', 'pending'], 0.6, 1] } },
  // Reporting points of a club map / chart: the same outline triangle and name as the base layer's VFR reporting points (wp-rp), and
  // switched with them (web "VFR Waypoints", native waypoints)
  { id: 'ad-reporting-point-icon', type: 'symbol', group: 'reportingPoints', minzoom: 9, filter: ['all', POINT, IS_RP],
    layout: { 'icon-image': 'wp-rp', 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 12, 0.7], 'icon-allow-overlap': true },
    paint: { 'icon-opacity': ['case', ['get', 'pending'], 0.6, 1] } },
  // The name looks for room: below the symbol, else above, beside it, or at a corner, so it does not collide with an obstacle or landmark label.
  // A point on a landmark of the same name keeps this label and the landmark's own label is left off (`landmarkLabelFilter`): one of the two always stays.
  { id: 'ad-reporting-point-label', type: 'symbol', group: 'reportingPoints', minzoom: 10, filter: ['all', POINT, IS_RP, ['!=', ['get', 'label'], '']],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-variable-anchor': LABEL_ANCHORS,
      'text-radial-offset': 0.9, 'text-justify': 'auto' },
    paint: { 'text-color': AREA_LABEL_COLOR, 'text-halo-color': HALO, 'text-halo-width': 1.8 } },
  { id: 'ad-details-label', type: 'symbol', group: 'details', minzoom: 10, filter: ['all', ['!=', ['get', 'label'], ''], ['!', ['all', POINT, IS_RP]]],
    layout: { 'text-field': ['get', 'label'], 'text-font': CIRCUIT_LABEL_FONT, 'text-size': 12, 'text-max-width': 12,
      'text-offset': ['case', ['==', ['geometry-type'], 'Point'], ['literal', [0, 1.1]], ['literal', [0, 0]]],
      'text-anchor': ['case', ['==', ['geometry-type'], 'Point'], 'top', 'center'] },
    // Dark text on a wide white halo, as the circuit labels: the kind colours (amber, green) vanish on the base map.
    paint: { 'text-color': AREA_LABEL_COLOR, 'text-halo-color': HALO, 'text-halo-width': 2.4, 'text-halo-blur': 0.3 } },
]

const KINDS_OF_GROUP: Record<DetailLayerSpec['group'], DetailKind[]> = {
  circuits: ['circuit_leg', 'arrival_route'],
  holdings: ['holding'],
  reportingPoints: ['reporting_point'],
  details: (Object.keys(DETAIL_KIND_COLOR) as DetailKind[]).filter(k => k !== 'circuit_leg' && k !== 'arrival_route' && k !== 'holding' && k !== 'reporting_point' && k !== 'runway'),
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
      const notRoute: Expr = ['!', ARRIVAL]
      return [...CIRCUIT_GROUPS.map(g => ({
        ...l,
        id: `${l.id}-${g}`,
        filter: ['all', l.filter, notRoute, g === 'powered' ? ['!', ['in', ['get', 'aircraft'], ['literal', special]]]
          : ['==', ['get', 'aircraft'], g]] as Expr,
        paint: { ...l.paint, ...Object.fromEntries(groupKeys.map(k => [k, CIRCUIT_GROUP_COLOR[g]])) },
      })), {
        ...l,
        id: `${l.id}-route`,
        filter: ['all', l.filter, ARRIVAL] as Expr,
        paint: { ...l.paint, ...Object.fromEntries(groupKeys.map(k => [k, DETAIL_KIND_COLOR.arrival_route])) },
      }]
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

/** Layers a tap can hit: the area edges and circuit lines first (a tap near an edge), the fill separately (a tap inside:
 *  an airspace under it keeps priority). */
export const DETAIL_TAP_EDGE_LAYERS = ['ad-details-outline', 'ad-details-outline-dashed', 'ad-details-line', 'ad-details-line-dashed',
  'ad-circuit-line', 'ad-circuit-line-dashed'] as const
export const DETAIL_TAP_FILL_LAYERS = ['ad-details-fill'] as const

export const CIRCUIT_LAYER_IDS = DETAIL_LAYERS.filter(l => l.group === 'circuits').map(l => l.id)
export const HOLDING_ORBIT_LAYER = 'ad-holding-orbit'
export const REPORTING_POINT_LAYER_IDS = DETAIL_LAYERS.filter(l => l.group === 'reportingPoints').map(l => l.id)

/** A circuit layer's filter with the runway focus: at the focused aerodrome only circuits for that runway end
 *  (circuits without known runways, such as drawn club legs, stay). Other layers are returned unchanged. */
export function layerFilter(l: DetailLayerSpec, focus: CircuitFocus | null, relevant?: readonly string[]): Expr {
  // Reporting points of club maps and charts belong to one airfield's arrivals: drawn only for the aerodromes in `relevant` (the one
  // whose card was last opened). `undefined` = no such rule (all drawn).
  if (l.group === 'reportingPoints' && relevant) return ['all', l.filter, ['in', ['get', 'aerodrome'], ['literal', [...relevant]]]]
  // the direction marks of a loop flown both ways exist only for a chosen runway end, and only at that aerodrome
  if (l.id.startsWith('ad-circuit-dirmarks')) {      // startsWith: the native style splits it per aircraft group (`ad-circuit-dirmarks-glider` ...)
    return focus ? ['all', l.filter, ['==', ['get', 'aerodrome'], focus.aerodrome], ['in', `|${focus.runway}|`, ['get', 'rwys']]] : ['all', l.filter, ['==', ['get', 'role'], 'hidden-until-a-runway-end-is-chosen']]      // always false, in expression form: a bare ['==', 0, 1] can make a native renderer read the whole filter as the old filter syntax
  }
  if (!focus || l.group !== 'circuits') return l.filter
  return ['all', l.filter, ['any', ['!=', ['get', 'aerodrome'], focus.aerodrome], ['!', ['has', 'rwys']],
    ['in', `|${focus.runway}|`, ['get', 'rwys']]]]
}

/**
 * The official runways a drawn runway corrects (a runway a person moved or resized in the review): the base runway lines to leave out ("ESMI|12/30") and the base end numbers
 * ("ESMI|12|GRASS": aerodrome, end, surface). `withoutRunways` puts them into a base layer's filter.
 */
export function replacedRunwayKeys(fc: { features: readonly Feature[] } | null | undefined): { lines: string[]; ends: string[] } {
  const lines = new Set<string>(), ends = new Set<string>()
  for (const f of fc?.features ?? []) {
    const p = f.properties as Partial<DetailProps> | null
    if (!p || p.kind !== 'runway' || !p.replaces || !p.aerodrome) continue
    if (f.geometry.type === 'LineString') {
      lines.add(`${p.aerodrome}|${p.replaces}`)
      for (const e of p.replaces.split(' ')[0]!.split('/')) if (/^\d{2}[LRC]?$/.test(e)) ends.add(`${p.aerodrome}|${e}|${(p.surface ?? 'GRASS').toUpperCase()}`)
    }
  }
  return { lines: [...lines], ends: [...ends] }
}

/** A base runway layer's filter with the replaced runways left out (`base` null = the layer has no filter). */
export function withoutRunways(base: Expr | null, keys: readonly string[], kind: 'line' | 'end'): Expr | null {
  if (!keys.length) return base
  const key: Expr = kind === 'line' ? ['concat', ['get', 'icao'], '|', ['get', 'designator']] : ['concat', ['get', 'icao'], '|', ['get', 'id'], '|', ['get', 'surface']]
  const hide: Expr = ['!', ['in', key, ['literal', [...keys]]]]
  return base ? ['all', base, hide] : hide
}

/** Is this reporting point drawn, given the aerodromes in `relevant` (`undefined` = the rule is off: all are drawn). */
export function isDrawnClubPoint(f: Feature, relevant?: readonly string[]): boolean {
  if (!relevant) return true
  const a = ((f.properties ?? {}) as Record<string, unknown>)['aerodrome']
  return typeof a === 'string' && relevant.includes(a)
}

/** Names of landmarks (churches, masts) that a drawn reporting point of the same name sits on, for the points that are drawn now (an aerodrome in
 *  `relevant`, the reporting-point layer switched on): the point's label names the place, so the landmark's own label is left off. */
export function landmarkNamesTakenByPoints(fc: { features: Feature[] } | null | undefined, relevant: readonly string[], visible: boolean): string[] {
  if (!fc || !visible) return []
  const out = new Set<string>()
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>
    if (p['kind'] === 'reporting_point' && p['on_landmark'] === true && typeof p['name'] === 'string' && p['name']
        && typeof p['aerodrome'] === 'string' && relevant.includes(p['aerodrome'])) out.add(p['name'])
  }
  return [...out]
}

/** A landmark label layer's filter without the landmarks a drawn reporting point names. */
export function landmarkLabelFilter(base: Expr, taken: readonly string[]): Expr {
  return taken.length ? ['all', base, ['!', ['in', ['get', 'name'], ['literal', [...taken]]]]] : base
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
  const all = [...details, ...schematicCircuitFeatures(aerodromes, drawn), ...holdingOrbitFeatures(details), ...directionFeatures(details)]
  return {
    type: 'FeatureCollection',
    features: all.map(f => {
      const named = f.properties.kind !== 'circuit_leg' && f.properties.kind !== 'arrival_route' && f.properties.kind !== 'holding' && !(f.properties.kind === 'runway' && f.geometry.type === 'Point')      // a runway's end numbers are drawn by their own layer
        && (f.geometry.type === 'Point' || AREA_KINDS.has(f.properties.kind as DetailKind))
      const area = named ? mapAreaLabel(f.properties, false) : ''
      return { ...f, properties: {
        ...f.properties,
        ...(isBothWaysLoop(f as DetailFeature) ? { oneWay: false } : {}),      // flown the other way round from the other end: no one-way marks of its own
        label: area ? [area, f.properties.pending ? '(unreviewed)' : null].filter(Boolean).join('\n') : '',
        clabel: f.properties.kind === 'circuit_leg' || f.properties.kind === 'arrival_route' ? circuitLabel(f.properties.name, f.properties.aircraft) : '',
        // flat copies for the tap popup (a rendered feature returns nested values as JSON text)
        limits: formatLimits(f.properties.floor, f.properties.ceiling) ?? '',
        below: belowText(f.properties.floor, f.properties.ceiling) ?? '',
        source: f.properties.provenance?.source_name ?? '',
      } }
    }),
  }
}

// What an area is, in English, in front of a place name taken from the source ("Central Västerås" alone says nothing).
const AREA_KIND_LABEL: Partial<Record<string, string>> = {
  noise_sensitive: 'Noise-sensitive area', avoid_area: 'Avoid area', glider_area: 'Glider area',
  parachute_area: 'Parachute area', model_area: 'Model aircraft area',
}

// A source's own words for the kind at the start of a name ("Noise-sensitive area Kastberga", "Bullerkänsligt omr Kastberga").
const KIND_WORDS_IN_NAME = /^(noise[- ]sensitive( area)?|bullerk[aä]nsligt( omr[aå]de| omr)?)\s*[:\-–]?\s*/i

/**
 * Map label of an area or point. A noise-sensitive area is labelled by its place name alone ("Kastberga"): the dashed outline
 * says it is an area and a tap says which kind, so the label need not repeat it; an unnamed one has no label at all. Other kinds
 * keep their kind in front of the name ("Glider area: Öresjö"), since a bare name there could be taken for a place.
 */
export function mapAreaLabel(p: Pick<DetailProps, 'kind' | 'name' | 'floor' | 'ceiling'>, withHeights = true): string {
  const kind = AREA_KIND_LABEL[p.kind]
  let name = p.name?.trim() ?? ''
  if (p.kind === 'noise_sensitive') name = name.replace(KIND_WORDS_IN_NAME, '').trim()
  const head = p.kind === 'noise_sensitive' ? name
    : kind && name && !name.toLowerCase().includes(kind.toLowerCase().split(' ')[0]!) ? `${kind}: ${name}` : (name || kind || '')
  if (!withHeights && p.kind === 'noise_sensitive') return head          // the height is in the tap popup, not written on the map
  const below = p.kind === 'noise_sensitive' ? belowText(p.floor, p.ceiling) : null
  return [head, below ? `below ${below}` : formatLimits(p.floor, p.ceiling)].filter(Boolean).join('\n')
}

/** "2500 ft AMSL" when the limit is a ceiling from the ground ("avoid below ..."), else null. */
export function belowText(floor: DetailProps['floor'], ceiling: DetailProps['ceiling']): string | null {
  const ground = !floor || (floor.ref === 'AGL' && floor.ft === 0)
  return ground && ceiling && ceiling.ref !== 'UNL' ? formatLimit(ceiling) : null
}

/** Map label of a circuit, short so it fits along the line: "RWY 06 RH · RWY 24 LH" -> "06 RH · 24 LH",
 *  "ESMI UL-landningsvarv" -> "UL-landningsvarv". A name of the merged form "Traffic circuit gliders (runway 12) — RWY 12 RH · RWY 30 LH"
 *  becomes "gliders · 12 RH · 30 LH": the sentence-long name is on the card, the map keeps who it is for and the hands. */
export function circuitLabel(name: string | null, aircraft?: string | null): string {
  const clean = (t: string) => t.replace(/^[A-Z]{4}\s+/, '').replace(/\bRWY\s*/gi, '').trim()
  const [head, tail] = (name ?? '').split(/\s+\u2014\s+/, 2)
  if (!tail) {
    // an unmerged name ("Traffic circuit powered aircraft (runway 12)"): the group is the label, the runway is in the hands on the card
    const m = /^Traffic circuit\s+(.*?)\s*(?:\([^)]*\))?\s*$/i.exec(head ?? '')
    return m ? clean(m[1]!) : clean(head ?? '')
  }
  const who = (aircraft ? ({ powered: 'powered', glider: 'gliders', ultralight: 'UL', helicopter: 'helicopters', gyro: 'gyros' } as Record<string, string>)[aircraft] : null)
    ?? clean((head ?? '').replace(/^Traffic circuit\s*/i, '').replace(/\s*\([^)]*\)\s*$/, ''))
  return [who, clean(tail)].filter(Boolean).join(' \u00B7 ')
}

export { idOf as aerodromeIdOf }
