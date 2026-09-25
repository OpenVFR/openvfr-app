/**
 * notamRouteFilter — proximity filtering for the regional NOTAMs briefing
 * list: NOTAMs within a configurable horizontal buffer of the planned
 * route, 5nm by default. Deliberately does NOT filter the map circle/point
 * layers themselves -- those stay showing everything currently active
 * while panning/exploring the map; only the list/panel view gets narrowed
 * to what's actually relevant to your route.
 *
 * Uses a flat-earth (equirectangular) approximation for point-to-route-
 * segment distance -- adequate for VFR-scale proximity triage ("is this
 * NOTAM near my route", not precision navigation), same accuracy tier as
 * other short-range geometry already in this codebase (e.g. AirspacePopup's
 * polygon-thumbnail projection).
 */

import { distanceNm } from './routeCalc'

export interface RoutePoint { lat: number; lng: number }

const NM_PER_DEG_LAT = 60

function toFlatXY(p: RoutePoint, cosLat: number): { x: number; y: number } {
  return { x: p.lng * cosLat * NM_PER_DEG_LAT, y: p.lat * NM_PER_DEG_LAT }
}

/** Perpendicular (lateral) distance in NM from `p` to the line segment
 *  `a`-`b`, plus `t` (0..1, how far along that segment the perpendicular
 *  projection lands) -- `t` is what lets a caller reconstruct "how far
 *  along the WHOLE route" this point projects to, not just "how close". */
function nearestOnSegmentNm(p: RoutePoint, a: RoutePoint, b: RoutePoint): { lateralNm: number; t: number } {
  const cosLat = Math.cos((p.lat * Math.PI) / 180)
  const P = toFlatXY(p, cosLat)
  const A = toFlatXY(a, cosLat)
  const B = toFlatXY(b, cosLat)
  const abx = B.x - A.x
  const aby = B.y - A.y
  const lenSq = abx * abx + aby * aby
  let t = lenSq > 0 ? ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq : 0
  t = Math.max(0, Math.min(1, t))
  const projX = A.x + t * abx
  const projY = A.y + t * aby
  const dx = P.x - projX
  const dy = P.y - projY
  return { lateralNm: Math.sqrt(dx * dx + dy * dy), t }
}

export interface RoutePosition {
  /** Perpendicular (cross-track) distance in NM from the route line --
   *  what `distanceToRouteNm` alone returns. */
  lateralNm: number
  /** Cumulative NM along the route (great-circle leg lengths, same basis
   *  as RoutePlan's/VirtualRadar's own totals) from the first waypoint to
   *  this point's perpendicular projection onto the nearest leg -- i.e.
   *  "how far into the route you'll be when you're abeam this", not just
   *  "how close it sits". Lets a caller order a proximity-filtered list by
   *  flight sequence (departure -> destination) instead of by raw/lateral
   *  distance, which groups by "how near" rather than "when you'll pass
   *  it" -- confusing on anything but a dead-straight route. */
  alongNm: number
}

/** Perpendicular distance + along-route position of `point` relative to
 *  `route` (2+ points) -- see RoutePosition's own field docs. */
export function nearestRoutePoint(point: RoutePoint, route: RoutePoint[]): RoutePosition {
  if (route.length === 0) return { lateralNm: Infinity, alongNm: 0 }
  if (route.length === 1) return { lateralNm: distanceNm(point, route[0]), alongNm: 0 }
  let best: RoutePosition = { lateralNm: Infinity, alongNm: 0 }
  let cumNm = 0
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1]
    const segNm = distanceNm(a, b)
    const { lateralNm, t } = nearestOnSegmentNm(point, a, b)
    if (lateralNm < best.lateralNm) best = { lateralNm, alongNm: cumNm + t * segNm }
    cumNm += segNm
  }
  return best
}

/** Shortest distance in NM from `point` to any segment of `route` (2+ points). */
export function distanceToRouteNm(point: RoutePoint, route: RoutePoint[]): number {
  return nearestRoutePoint(point, route).lateralNm
}

export const DEFAULT_ROUTE_NOTAM_BUFFER_NM = 5

// Minimal structural shape of NotamItem's `polygon` field (see
// fetchNotam.ts's NotamPolygonGeometry) -- kept local rather than imported
// to avoid a cross-file type dependency for two field names.
interface RingGeometry {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}

/** Every exterior-ring vertex [[lng,lat]...] across a Polygon or MultiPolygon
 *  (holes ignored -- irrelevant for a "how close is this area" check). */
function exteriorRingVertices(geom: RingGeometry): RoutePoint[] {
  const rings: number[][][] = geom.type === 'Polygon'
    ? [geom.coordinates[0] as number[][]]
    : (geom.coordinates as number[][][][]).map((poly) => poly[0])
  return rings.flat().map(([lng, lat]) => ({ lat, lng }))
}

/**
 * Filters a list of NotamItem-shaped geo entries down to ones within
 * `bufferNm` of `route` -- accounting for the NOTAM's own radius (a large
 * circular area only needs its EDGE within the buffer, not its centre), or
 * for a real polygon (`polygon`), the closest vertex of its exterior ring
 * (a reasonable proxy for "closest edge" at VFR-triage accuracy -- same
 * tier as this file's other flat-earth approximations). Only entries with
 * NEITHER lat/lon NOR polygon geometry (text-only administrative NOTAMs --
 * AIRAC amendments, NOTAM checklists, etc.) are always kept: there's no
 * geometry to judge relevance by there, so err on inclusion rather than
 * silently hiding something that could matter.
 *
 * Previously this only ever looked at lat/lon/radiusNm, silently treating
 * every polygon-geometry NOTAM (cross-border military exercise areas, low-
 * level corridor notices -- routinely the bulk of a live regional feed,
 * confirmed live) as "no geometry, always keep", since `polygon` NOTAMs
 * carry lat=lon=radiusNm=null by design (see NotamItem's own doc comment).
 * That silently disabled the route filter for exactly the NOTAM shape it
 * most needed to filter, letting NOTAMs from anywhere in Europe leak into
 * a list labelled "filtered to within Nnm of planned route".
 */
export function filterNotamsNearRoute<T extends {
  lat: number | null
  lon: number | null
  radiusNm: number | null
  polygon?: RingGeometry | null
}>(
  notams: T[],
  route: RoutePoint[],
  bufferNm: number = DEFAULT_ROUTE_NOTAM_BUFFER_NM,
): T[] {
  if (route.length === 0) return notams
  return notams.filter((n) => {
    if (n.polygon) {
      const vertices = exteriorRingVertices(n.polygon)
      if (vertices.length === 0) return true // malformed geometry -- err on inclusion
      return vertices.some((v) => distanceToRouteNm(v, route) <= bufferNm)
    }
    if (n.lat === null || n.lon === null) return true
    const dist = distanceToRouteNm({ lat: n.lat, lng: n.lon }, route)
    const radius = n.radiusNm ?? 0
    return dist - radius <= bufferNm
  })
}

/**
 * Along-route position of a NotamItem-shaped entry, for ordering an
 * already-filtered list by flight sequence instead of by raw/lateral
 * distance or an unrelated key (e.g. RegionalNotamsPanel's previous
 * icaoLocation-alphabetical sort) -- see RoutePosition's own field docs.
 * Same geometry priority as filterNotamsNearRoute (polygon > lat/lon), same
 * closest-vertex proxy for a polygon's position. Returns null only for
 * entries with neither lat/lon nor polygon (text-only administrative
 * NOTAMs) -- caller decides how to place those (e.g. sort them last).
 */
export function notamRoutePosition<T extends {
  lat: number | null
  lon: number | null
  polygon?: RingGeometry | null
}>(notam: T, route: RoutePoint[]): RoutePosition | null {
  if (notam.polygon) {
    const vertices = exteriorRingVertices(notam.polygon)
    if (vertices.length === 0) return null
    let best: RoutePosition | null = null
    for (const v of vertices) {
      const pos = nearestRoutePoint(v, route)
      if (!best || pos.lateralNm < best.lateralNm) best = pos
    }
    return best
  }
  if (notam.lat === null || notam.lon === null) return null
  return nearestRoutePoint({ lat: notam.lat, lng: notam.lon }, route)
}

/**
 * `filterNotamsNearRoute` + sort by along-route position (flight sequence,
 * departure -> destination), NOT the alphabetical-by-icaoLocation fallback
 * that made sense before any route context existed. Entries with no
 * computable position (text-only administrative NOTAMs -- always kept by
 * the filter above) sort last. Single shared implementation reused by every
 * "NOTAMs near my route" list surface (web's AerodromePopup.tsx +
 * RegionalNotamsPanel.tsx, native's AerodromeNotamSection.tsx) rather than
 * each re-deriving the same comparator.
 */
export function filterAndSortNotamsNearRoute<T extends {
  lat: number | null
  lon: number | null
  radiusNm: number | null
  polygon?: RingGeometry | null
}>(
  notams: T[],
  route: RoutePoint[],
  bufferNm: number = DEFAULT_ROUTE_NOTAM_BUFFER_NM,
): T[] {
  if (route.length === 0) return notams
  return filterNotamsNearRoute(notams, route, bufferNm).sort((a, b) => {
    const posA = notamRoutePosition(a, route)
    const posB = notamRoutePosition(b, route)
    if (!posA && !posB) return 0
    if (!posA) return 1
    if (!posB) return -1
    return posA.alongNm - posB.alongNm
  })
}

/** Same idea, scoped to a single position (e.g. live GPS) instead of a route. */
export function filterNotamsNearPosition<T extends { lat: number | null; lon: number | null; radiusNm: number | null }>(
  notams: T[],
  position: RoutePoint,
  bufferNm: number = DEFAULT_ROUTE_NOTAM_BUFFER_NM,
): T[] {
  return notams.filter((n) => {
    if (n.lat === null || n.lon === null) return true
    const dist = distanceNm(position, { lat: n.lat, lng: n.lon })
    const radius = n.radiusNm ?? 0
    return dist - radius <= bufferNm
  })
}
