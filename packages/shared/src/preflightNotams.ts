/**
 * NOTAM-created restricted areas on the planned route, for the pre-flight
 * check. Only areas the chart does not already draw: a NOTAM naming a charted
 * restricted/danger area by its designator is covered by the airspace check
 * (matchNotamsToAirspace), so it is not reported twice.
 *
 * Considered: Q-code subject RT (temporary restricted), RD (danger),
 * RP (prohibited), RR (restricted). Area = the NOTAM's own polygon, else its
 * Q-line circle. Only NOTAMs in force within the look-ahead window count
 * (their own schedule, see notamSchedule).
 *
 * Vertical limits come from the Q-line FL range, compared with the planned
 * level at the point of the route nearest the area's centre: an
 * approximation that is right for the usual compact area and errs towards
 * warning for one crossed at two levels.
 */
import booleanIntersects from '@turf/boolean-intersects'
import { lineString } from '@turf/helpers'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { NotamItem } from './fetchNotam'
import { buildAirspaceIndex, matchNotamsToAirspace, notamMapFeatures, notamsInWindow, NOTAM_MAP_HORIZON_MS } from './notamMapLayers'
import { nearestRoutePoint } from './notamRouteFilter'
import type { RouteWaypoint } from './types'

const RESTRICTED_SUBJECTS = ['RT', 'RD', 'RP', 'RR']
/** Q-code conditions of a NOTAM that is not in force (withdrawn, cancelled, completed, deactivated, trigger): not an area to avoid. */
const NOT_IN_FORCE = new Set(['TT', 'AW', 'CD', 'CC', 'CN'])

export interface RouteNotamArea {
  notam: NotamItem
  /** NM along the route at the point nearest the area's centre. */
  alongNm: number
  lowerFt: number
  upperFt: number
}

const flToFt = (fl: string | null | undefined, fallback: number): number => {
  if (fl == null || fl === '') return fallback
  const n = Number(fl)
  return Number.isFinite(n) ? n * 100 : fallback
}

function ringCentre(g: Polygon | MultiPolygon): { lat: number; lng: number } {
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0]?.[0]
  if (!ring || ring.length === 0) return { lat: 0, lng: 0 }
  let lat = 0, lng = 0
  for (const [x, y] of ring) { lng += x!; lat += y! }
  return { lat: lat / ring.length, lng: lng / ring.length }
}

export function routeNotamAreas(opts: {
  notams: readonly NotamItem[]
  waypoints: RouteWaypoint[]
  /** Charted airspace, to leave out areas the airspace check already covers. */
  airspace?: FeatureCollection | null
  nowMs?: number
}): RouteNotamArea[] {
  const { notams, waypoints, airspace } = opts
  if (waypoints.length < 2 || notams.length === 0) return []
  const nowMs = opts.nowMs ?? Date.now()
  const restricted = notamsInWindow(notams, nowMs, nowMs + NOTAM_MAP_HORIZON_MS).filter((n) => {
    const q = (n.qCode ?? '').toUpperCase().replace(/^Q/, '')
    return RESTRICTED_SUBJECTS.includes(q.slice(0, 2)) && !NOT_IN_FORCE.has(q.slice(2, 4))
  })
  if (restricted.length === 0) return []

  const matched = airspace ? matchNotamsToAirspace(buildAirspaceIndex(airspace), restricted).matchedNotamIds : new Set<string>()
  const { circles, polygons } = notamMapFeatures(restricted, matched)
  const route = lineString(waypoints.map((w) => [w.lng, w.lat]))
  const latlng = waypoints.map((w) => ({ lat: w.lat, lng: w.lng }))
  const byId = new Map(restricted.map((n) => [n.nmsId, n]))

  const out: RouteNotamArea[] = []
  const seen = new Set<string>()
  for (const f of [...polygons, ...circles] as Feature<Polygon | MultiPolygon>[]) {
    const id = String((f.properties as { nmsId?: string } | null)?.nmsId ?? '')
    const notam = byId.get(id)
    if (!notam || seen.has(id)) continue
    if (!booleanIntersects(route, f)) continue
    seen.add(id)
    out.push({
      notam,
      alongNm: nearestRoutePoint(ringCentre(f.geometry), latlng).alongNm,
      lowerFt: flToFt(notam.icao?.lowerFl, 0),
      upperFt: flToFt(notam.icao?.upperFl, 99_900),
    })
  }
  return out.sort((a, b) => a.alongNm - b.alongNm)
}

/** First line of the NOTAM text, trimmed for a card. */
export function notamSummary(n: NotamItem, max = 140): string {
  const text = n.text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
