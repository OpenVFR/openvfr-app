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

/** Shortest distance in NM from `p` to the line segment `a`-`b`. */
function distanceToSegmentNm(p: RoutePoint, a: RoutePoint, b: RoutePoint): number {
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
  return Math.sqrt(dx * dx + dy * dy)
}

/** Shortest distance in NM from `point` to any segment of `route` (2+ points). */
export function distanceToRouteNm(point: RoutePoint, route: RoutePoint[]): number {
  if (route.length === 0) return Infinity
  if (route.length === 1) return distanceNm(point, route[0])
  let min = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const d = distanceToSegmentNm(point, route[i], route[i + 1])
    if (d < min) min = d
  }
  return min
}

export const DEFAULT_ROUTE_NOTAM_BUFFER_NM = 5

/**
 * Filters a list of NotamItem-shaped geo entries down to ones within
 * `bufferNm` of `route` -- accounting for the NOTAM's own radius (a large
 * area only needs its EDGE within the buffer, not its centre). Entries with
 * no lat/lon (text-only administrative NOTAMs -- AIRAC amendments, NOTAM
 * checklists, etc.) are always kept: there's no geometry to judge relevance
 * by, so err on inclusion rather than silently hiding something that could
 * matter.
 */
export function filterNotamsNearRoute<T extends { lat: number | null; lon: number | null; radiusNm: number | null }>(
  notams: T[],
  route: RoutePoint[],
  bufferNm: number = DEFAULT_ROUTE_NOTAM_BUFFER_NM,
): T[] {
  if (route.length === 0) return notams
  return notams.filter((n) => {
    if (n.lat === null || n.lon === null) return true
    const dist = distanceToRouteNm({ lat: n.lat, lng: n.lon }, route)
    const radius = n.radiusNm ?? 0
    return dist - radius <= bufferNm
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
