/**
 * Flight logs and the route that was planned for them, and merging logs broken
 * by a GPS loss. Shared by web and native.
 *
 * A log can carry the route that was active when it was recorded (`routeJson`
 * on the log, migration 20261110000000). The profile then shows the planned
 * level along the flown track as a faint line, wherever the track ran close
 * to the route.
 */

import { buildVirtualRadarProfile, plannedAltitudeLine, distanceAlongRouteNm, routeCrossTrackNm, type AircraftPerfModel } from './virtualRadarCalc'
import type { RouteWaypoint } from './routeCalc'
import type { LegOverride, FlightLogDocType } from './types'
import { trackDistanceNm } from './gpx'

/** The planned route stored with a log. */
export interface FlightLogRoute {
  name?:        string
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraftId?:  string
}

/** JSON for a log's `routeJson`, or undefined when there is no route worth keeping. */
export function logRouteJson(route: FlightLogRoute | null | undefined): string | undefined {
  if (!route || route.waypoints.length < 2) return undefined
  const waypoints = route.waypoints.map((w) => ({ lat: w.lat, lng: w.lng, ...(w.name ? { name: w.name } : {}) }))
  return JSON.stringify({ ...route, waypoints })
}

/** The route stored with a log; null when none or unreadable. */
export function parseLogRoute(json: string | null | undefined): FlightLogRoute | null {
  if (!json) return null
  try {
    const r = JSON.parse(json) as Partial<FlightLogRoute>
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2) return null
    const waypoints = r.waypoints.filter((w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lng))
    if (waypoints.length < 2) return null
    return { name: r.name, waypoints, legOverrides: Array.isArray(r.legOverrides) ? r.legOverrides : [], aircraftId: r.aircraftId }
  } catch {
    return null
  }
}

const NO_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
/** Farther than this from the route, the planned level says nothing about where the aircraft was. */
export const PLANNED_MAX_OFF_ROUTE_NM = 2

/**
 * Planned altitude at each sample of the flown track (lat/lng of the track at
 * the chart's sample distances): the route's level at the point of the route
 * nearest to the sample, with climbs and descents from the aircraft's
 * performance. null where the track is more than PLANNED_MAX_OFF_ROUTE_NM off
 * the route. Departure and arrival are taken at 0 ft (the route carries no
 * aerodrome elevations), so the first and last climb are slightly off there.
 */
export function plannedAltitudesAlongTrack(
  route: FlightLogRoute,
  samples: readonly { lat: number; lng: number }[],
  perf: AircraftPerfModel | null | undefined,
  defaultAltFt?: number,
): (number | null)[] {
  const prof = buildVirtualRadarProfile(route.waypoints, route.legOverrides, NO_FEATURES, NO_FEATURES, undefined, undefined, Infinity, defaultAltFt)
  const line = plannedAltitudeLine(prof.altitudeProfile, prof.totalNm, perf)
  if (line.length < 2) return samples.map(() => null)
  const at = (d: number): number => {
    if (d <= line[0].distNm) return line[0].altFt
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k], b = line[k + 1]
      if (d <= b.distNm) return b.distNm === a.distNm ? b.altFt : a.altFt + ((d - a.distNm) / (b.distNm - a.distNm)) * (b.altFt - a.altFt)
    }
    return line[line.length - 1].altFt
  }
  return samples.map((s) => {
    if (Math.abs(routeCrossTrackNm(route.waypoints, s)) > PLANNED_MAX_OFF_ROUTE_NM) return null
    return at(distanceAlongRouteNm(route.waypoints, s))
  })
}

// ── Merging logs broken by a GPS loss ────────────────────────────────────────

/** The second log continues the first if it starts at most this long after the first ends. */
export const MERGE_MAX_GAP_MS = 10 * 60_000
/** ...and was already flying (this fast) within its first MERGE_AIRBORNE_WITHIN_MS. */
export const MERGE_AIRBORNE_KTS = 30
export const MERGE_AIRBORNE_WITHIN_MS = 10_000

type MergeableLog = Pick<FlightLogDocType, 'id' | 'startedAt' | 'endedAt' | 'aircraftId' | 'registration' | 'trackJson'> & { simulated?: boolean }

function trackOf(log: { trackJson: string }): { lat: number; lng: number; altFt: number; spdKts: number; trkDeg?: number; ts: number }[] {
  try { return JSON.parse(log.trackJson || '[]') } catch { return [] }
}

/**
 * Whether `next` continues `first` after the recording broke off (GPS lost,
 * app killed): same aircraft (or both without one), `next` starts after
 * `first` ends and at most MERGE_MAX_GAP_MS later, and `next` was already
 * airborne at its start (a new takeoff is a new flight, not a continuation).
 * Simulated and in-progress logs never merge.
 */
export function canMergeLogs(first: MergeableLog, next: MergeableLog): boolean {
  if (first.id === next.id || first.simulated || next.simulated) return false
  if (first.endedAt <= 0 || next.endedAt <= 0) return false
  const sameAircraft = (first.aircraftId || first.registration) === (next.aircraftId || next.registration)
  if (!sameAircraft) return false
  const gap = next.startedAt - first.endedAt
  if (gap < 0 || gap > MERGE_MAX_GAP_MS) return false
  const t = trackOf(next)
  if (t.length === 0) return false
  const t0 = t[0].ts
  let max = 0
  for (const p of t) {
    if (p.ts - t0 > MERGE_AIRBORNE_WITHIN_MS) break
    if (Number.isFinite(p.spdKts)) max = Math.max(max, p.spdKts)
  }
  return max >= MERGE_AIRBORNE_KTS
}

/**
 * `first` with `next` appended, as a new log `id`: the combined track (the
 * hole between them stays a recording gap), `first`'s start, departure,
 * aircraft and route, `next`'s arrival, distance and maximum altitude
 * recomputed. The caller saves it, then deletes both parts. A new log (an
 * insert) rather than an edit of `first`: it is accepted by any server, also
 * one still without log updates, where an edit would be refused while the
 * delete of `next` went through, losing that part from the account.
 */
export function mergeLogs<L extends FlightLogDocType>(first: L, next: L, id: string, now: number = Date.now()): L {
  const track = [...trackOf(first), ...trackOf(next)].sort((a, b) => a.ts - b.ts)
  const maxAlt = track.reduce((m, p) => (Number.isFinite(p.altFt) ? Math.max(m, p.altFt) : m), 0)
  return {
    ...first,
    id,
    endedAt:      Math.max(first.endedAt, next.endedAt),
    trackJson:    JSON.stringify(track),
    arrivalIcao:  next.arrivalIcao || first.arrivalIcao,
    distanceNm:   trackDistanceNm(track),
    maxAltFt:     Math.round(maxAlt),
    routeJson:    first.routeJson ?? next.routeJson,
    updatedAt:    now,
  }
}

/** For each log (any order), the log it can be merged with next, if any: id -> next id. */
export function mergeCandidates(logs: readonly MergeableLog[]): Map<string, string> {
  const sorted = [...logs].filter((l) => l.endedAt > 0).sort((a, b) => a.startedAt - b.startedAt)
  const out = new Map<string, string>()
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (canMergeLogs(sorted[i], sorted[i + 1])) out.set(sorted[i].id, sorted[i + 1].id)
  }
  return out
}
