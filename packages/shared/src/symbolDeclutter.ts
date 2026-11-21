/**
 * Symbols that must not sit on top of each other: a club reporting point (the triangle) next to a landmark (church, mast) or an obstacle
 * (wind turbine). MapLibre moves a label to a free side by itself, but never an icon, so the triangle is moved here, for the current zoom:
 * a point that collides with a symbol the map draws is shifted to the nearest free spot beside it (screen pixels, so the gap looks the same at
 * every zoom). Its true position stays in the feature (`lon0`, `lat0`); the label follows the shifted symbol because both are drawn from the
 * same (shifted) geometry. Pure functions, shared by web and native: the caller supplies the camera and the symbols it draws.
 */
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Point } from 'geojson'

/** The camera: centre, zoom (512 px tiles), bearing in degrees, viewport in CSS pixels. Pitched views are not handled (no shifting). */
export interface View { lon: number; lat: number; zoom: number; bearing: number; width: number; height: number; pitch?: number }
/** A symbol the map draws at a place: its centre and radius in screen pixels. */
export interface Blocker { lon: number; lat: number; r: number }

const TILE = 512
const RAD = Math.PI / 180

function world(lon: number, lat: number, zoom: number): [number, number] {
  const s = TILE * 2 ** zoom
  const sin = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * RAD)
  return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s]
}

function unworld(x: number, y: number, zoom: number): [number, number] {
  const s = TILE * 2 ** zoom
  const lon = x / s * 360 - 180
  const n = Math.PI - 2 * Math.PI * y / s
  return [lon, Math.atan(Math.sinh(n)) / RAD]
}

/** Screen position (pixels from the top-left) of a place. */
export function toScreen(lon: number, lat: number, v: View): [number, number] {
  const [cx, cy] = world(v.lon, v.lat, v.zoom)
  const [wx, wy] = world(lon, lat, v.zoom)
  const t = -v.bearing * RAD, c = Math.cos(t), s = Math.sin(t)
  const dx = wx - cx, dy = wy - cy
  return [dx * c - dy * s + v.width / 2, dx * s + dy * c + v.height / 2]
}

/** The place under a screen position. */
export function toLonLat(x: number, y: number, v: View): [number, number] {
  const [cx, cy] = world(v.lon, v.lat, v.zoom)
  const t = v.bearing * RAD, c = Math.cos(t), s = Math.sin(t)
  const dx = x - v.width / 2, dy = y - v.height / 2
  return unworld(cx + dx * c - dy * s, cy + dx * s + dy * c, v.zoom)
}

const lerp = (z: number, stops: [number, number][]): number => {
  if (z <= stops[0][0]) return stops[0][1]
  for (let i = 1; i < stops.length; i++) {
    if (z <= stops[i][0]) { const [z0, a] = stops[i - 1], [z1, b] = stops[i]; return a + (b - a) * (z - z0) / (z1 - z0) }
  }
  return stops[stops.length - 1][1]
}

/** Radii (px) of the symbols as the web style draws them (landmark icon 24 px at icon-size 0.35..1.0, obstacle circle 2.5..7 px, the point's triangle 24 px at 0.45..0.7). */
export const landmarkRadius = (zoom: number): number => 12 * lerp(zoom, [[10, 0.35], [12, 0.55], [14, 0.8], [16, 1]]) + 1
export const obstacleRadius = (zoom: number): number => lerp(zoom, [[11, 2.5], [16, 7]]) + 1.5
export const reportingRadius = (zoom: number): number => 12 * lerp(zoom, [[9, 0.45], [12, 0.7]]) + 1

/** How big the symbols are drawn, as radii in pixels per zoom: each platform passes the radii of its own style. */
export interface Radii { landmark: (zoom: number) => number; obstacle: (zoom: number) => number; reporting: (zoom: number) => number }
export const WEB_RADII: Radii = { landmark: landmarkRadius, obstacle: obstacleRadius, reporting: reportingRadius }
/** The native style draws its landmark icons (24 px at icon-size 0.3..0.5) and base reporting-point icons (0.22..0.5) smaller. */
export const NATIVE_RADII: Radii = {
  landmark: zoom => 12 * lerp(zoom, [[10, 0.3], [14, 0.5]]) + 1,
  obstacle: obstacleRadius,
  reporting: zoom => 12 * lerp(zoom, [[8, 0.22], [10, 0.35], [13, 0.5]]) + 1,
}

const ANGLES = [0, 180, -90, 90, -45, 45, -135, 135]          // right, left, up, down, then the corners (degrees, screen)
const STEPS = [1, 1.5, 2.1, 2.8]                                 // times the gap needed to clear one symbol

/**
 * Where each mark ends up: its own place when nothing collides, else the nearest free spot beside what it collides with.
 * Marks are placed in the order given (the first keeps its place), each also avoiding the marks placed before it.
 * `marks` and `blockers` are in screen pixels; -> offsets in pixels (dx, dy) per mark id, only for marks that moved.
 */
export function placeMarks(marks: { id: string; x: number; y: number; r: number }[], blockers: { x: number; y: number; r: number }[],
  gap = 3): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>()
  const taken: { x: number; y: number; r: number }[] = []
  const free = (x: number, y: number, r: number) =>
    !blockers.some(b => Math.hypot(b.x - x, b.y - y) < b.r + r + gap * 0.3) && !taken.some(b => Math.hypot(b.x - x, b.y - y) < b.r + r + gap * 0.3)
  for (const m of marks) {
    if (free(m.x, m.y, m.r)) { taken.push({ x: m.x, y: m.y, r: m.r }); continue }
    const near = [...blockers, ...taken].filter(b => Math.hypot(b.x - m.x, b.y - m.y) < b.r + m.r + 40)
    const clear = m.r + gap + Math.max(0, ...near.map(b => b.r))
    let put: [number, number] | null = null
    for (const k of STEPS) {
      for (const a of ANGLES) {
        const dx = Math.cos(a * RAD) * clear * k, dy = Math.sin(a * RAD) * clear * k
        if (free(m.x + dx, m.y + dy, m.r)) { put = [dx, dy]; break }
      }
      if (put) break
    }
    if (put) { out.set(m.id, put); taken.push({ x: m.x + put[0], y: m.y + put[1], r: m.r }) } else taken.push({ x: m.x, y: m.y, r: m.r })
  }
  return out
}

type PointFeature = Feature<Point, Record<string, unknown>>

const props = (f: Feature): Record<string, unknown> => (f.properties ?? {}) as Record<string, unknown>
const isPoint = (f: Feature): f is PointFeature => f.geometry?.type === 'Point'

/** A club reporting point of the aerodrome-details layer (a VFR reporting point read from a club map or chart): may be moved beside what it collides with. */
const isClubPoint = (f: Feature): boolean => isPoint(f) && props(f)['kind'] === 'reporting_point'
/** A VFR reporting point (RP) of the base waypoint layer: may be moved. A MANDATORY reporting point (MRP) and a holding point are never moved: they sit exactly where they are
 *  and everything else moves away from them. */
const isBaseVfrPoint = (f: Feature): boolean => isPoint(f) && props(f)['wp_type'] === 'RP' && !String(props(f)['name'] ?? '').toUpperCase().startsWith('HOLDING')

/** A point of the base waypoint layer (it has a `wp_type`). */
const isBaseWaypoint = (f: Feature): boolean => props(f)['wp_type'] !== undefined

const pointKey = (f: PointFeature): string => `${String(props(f)['aerodrome'] ?? '')}|${String(props(f)['name'] ?? '')}|${props(f)['lon0'] ?? f.geometry.coordinates[0]}|${props(f)['lat0'] ?? f.geometry.coordinates[1]}`

/**
 * The features with the movable points moved clear of the fixed symbols (`blockers`, and every point of `fc` that is not movable) for this view. Positions are restored from
 * `lon0`/`lat0` first, so calling it again on its own result for another view is safe. A pitched view (the projection is not flat) and a point outside the screen are left where
 * they are.
 */
function displaceWhere(fc: FeatureCollection, movable: (f: Feature) => boolean, blockers: Blocker[], v: View, radii: Radii): FeatureCollection {
  if (!Array.isArray(fc?.features)) return fc            // not a collection (a file URL a map source reads itself, or no data): nothing to place
  const original = restore(fc)
  if ((v.pitch ?? 0) > 1) return original
  const margin = 120
  const onScreen = (x: number, y: number) => x > -margin && y > -margin && x < v.width + margin && y < v.height + margin
  const rp = radii.reporting(v.zoom)
  const fixed: Blocker[] = [...blockers]
  for (const f of original.features) {
    // a base-layer waypoint that may not move (a mandatory reporting point, a holding point) is a fixed symbol; the club points and other layers' features are not waypoints
    if (isPoint(f) && !movable(f) && isBaseWaypoint(f)) fixed.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], r: rp })
  }
  const bs = fixed.map(b => { const [x, y] = toScreen(b.lon, b.lat, v); return { x, y, r: b.r } }).filter(b => onScreen(b.x, b.y))
  const marks = original.features.filter((f): f is PointFeature => isPoint(f) && movable(f))
    .map(f => { const [x, y] = toScreen(f.geometry.coordinates[0], f.geometry.coordinates[1], v); return { id: pointKey(f), x, y, r: rp } })
    .filter(m => onScreen(m.x, m.y))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const moved = placeMarks(marks, bs)
  if (!moved.size) return original
  const by = new Map(marks.map(m => [m.id, m]))
  return {
    ...original,
    features: original.features.map(f => {
      if (!isPoint(f) || !movable(f)) return f
      const m = by.get(pointKey(f)), d = m && moved.get(m.id)
      if (!m || !d) return f
      const [lon, lat] = toLonLat(m.x + d[0], m.y + d[1], v)
      return { ...f, geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { ...props(f), lon0: f.geometry.coordinates[0], lat0: f.geometry.coordinates[1], displaced: true } } as typeof f
    }),
  }
}

/** Club reporting points (aerodrome details) moved clear of `blockers` (landmarks, obstacles, the base layer's waypoints: see `waypointBlockers`). */
export function displaceReportingPoints(fc: FeatureCollection, blockers: Blocker[], v: View, drawn?: (f: Feature) => boolean, radii: Radii = WEB_RADII): FeatureCollection {
  // `drawn`: only the points the layer shows take part (the hidden points of a neighbouring aerodrome must not push the visible ones aside)
  return displaceWhere(fc, f => isClubPoint(f) && (drawn ? drawn(f) : true), blockers, v, radii)
}

/** The base waypoint layer: VFR reporting points (RP) moved clear of `blockers`; mandatory reporting points (MRP) and holding points stay exactly where they are and are
 *  blockers themselves. */
export function displaceWaypoints(fc: FeatureCollection, blockers: Blocker[], v: View, radii: Radii = WEB_RADII): FeatureCollection {
  return displaceWhere(fc, isBaseVfrPoint, blockers, v, radii)
}

/** Every waypoint of the base layer as a fixed symbol, for the club points to keep clear of (a club point is never put on a mandatory reporting point). */
export function waypointBlockers(fc: FeatureCollection | null | undefined, zoom: number, radii: Radii = WEB_RADII): Blocker[] {
  const r = radii.reporting(zoom)
  return (Array.isArray(fc?.features) ? fc!.features : []).filter(isPoint).map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], r }))
}

/** Where a point really is: a displaced point keeps its true position in `lon0`/`lat0`. A route, a popup, a snap and "what is here" always use this one. */
export function truePosition(feature: { geometry: Geometry; properties?: GeoJsonProperties }): [number, number] {
  const [lng, lat] = (feature.geometry as Point).coordinates as [number, number]
  const p = (feature.properties ?? {}) as Record<string, unknown>
  return typeof p['lon0'] === 'number' && typeof p['lat0'] === 'number' ? [p['lon0'], p['lat0']] : [lng, lat]
}

/** Features with every displaced point back at its true position. */
export function restore(fc: FeatureCollection): FeatureCollection {
  if (!Array.isArray(fc?.features) || !fc.features.some(f => props(f)['displaced'])) return fc
  return {
    ...fc,
    features: fc.features.map(f => {
      const p = props(f)
      if (!p['displaced'] || f.geometry?.type !== 'Point') return f
      const { lon0, lat0, displaced: _d, ...rest } = p
      void _d
      return { ...f, geometry: { type: 'Point', coordinates: [lon0 as number, lat0 as number] }, properties: rest }
    }),
  }
}

/** True when two results move the same points to the same places (to avoid setting the same data again). */
export function sameDisplacement(a: FeatureCollection, b: FeatureCollection): boolean {
  const key = (fc: FeatureCollection) => fc.features.filter(f => props(f)['displaced'] && isPoint(f))
    .map(f => `${pointKey(f as PointFeature)}@${((f.geometry as Point).coordinates).map(n => n.toFixed(6)).join(',')}`).sort().join(';')
  return key(a) === key(b)
}
