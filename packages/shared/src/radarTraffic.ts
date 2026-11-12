/**
 * Traffic on the Virtual Radar (web VirtualRadar.tsx, native VerticalProfile.tsx):
 * live targets from the same feed and the same vertical filter as the map,
 * placed on the side profile by how far along the route they are (x) and their
 * altitude (y). Only targets inside the abeam corridor the chart already uses
 * for terrain and the MSA are kept, so the chart is not filled with aircraft
 * nobody on the route could meet.
 */
import { lineString, point } from '@turf/helpers'
import nearestPointOnLine from '@turf/nearest-point-on-line'
import type { RouteWaypoint } from './types'
import { bearingDeg } from './routeCalc'

/** The part of a traffic target the chart needs (web and native TrafficTarget both fit). */
export interface RadarTrafficTarget {
  icao24: string
  callsign: string | null
  lat: number
  lon: number
  /** Feet, GNSS when the feed has it, else pressure altitude. */
  altFt: number
  trackDeg: number
  /** Feet per minute, + climbing. */
  vertFpm: number
  onGround: boolean
}

export interface TrafficMark<T extends RadarTrafficTarget = RadarTrafficTarget> {
  target: T
  /** NM along the route. */
  distNm: number
  /** Perpendicular distance from the route, NM. */
  offRouteNm: number
  /** Flying along the route direction (+1, drawn pointing right) or against it (-1, pointing left). */
  dir: 1 | -1
}

/** Lateral distance up to which a target is drawn at full strength; beyond it fades to {@link MIN_OPACITY} at the corridor edge. */
export const TRAFFIC_FULL_OPACITY_NM = 1
const MIN_OPACITY = 0.45

/** Opacity of a mark by lateral distance from the route (1 near the line, fading toward the corridor edge). */
export function trafficOpacity(offRouteNm: number, corridorNm: number): number {
  if (offRouteNm <= TRAFFIC_FULL_OPACITY_NM || corridorNm <= TRAFFIC_FULL_OPACITY_NM) return 1
  const t = Math.min(1, (offRouteNm - TRAFFIC_FULL_OPACITY_NM) / (corridorNm - TRAFFIC_FULL_OPACITY_NM))
  return 1 - t * (1 - MIN_OPACITY)
}

/**
 * Targets within `corridorNm` of the route and along it (0..totalNm), airborne
 * only, with their position along the route and which way they fly.
 */
export function projectTrafficMarks<T extends RadarTrafficTarget>(
  waypoints: RouteWaypoint[],
  targets: readonly T[],
  totalNm: number,
  corridorNm: number,
): TrafficMark<T>[] {
  if (targets.length === 0 || waypoints.length < 2) return []
  const line = lineString(waypoints.map((w) => [w.lng, w.lat]))
  const out: TrafficMark<T>[] = []
  for (const t of targets) {
    if (t.onGround || !Number.isFinite(t.altFt)) continue
    const snapped = nearestPointOnLine(line, point([t.lon, t.lat]), { units: 'kilometers' })
    const offRouteNm = (snapped.properties.dist ?? Infinity) / 1.852
    if (offRouteNm > corridorNm) continue
    const distNm = (snapped.properties.location ?? 0) / 1.852
    if (distNm < 0 || distNm > totalNm) continue
    const seg = Math.min(Math.max(snapped.properties.index ?? 0, 0), waypoints.length - 2)
    const routeBrg = bearingDeg(waypoints[seg]!, waypoints[seg + 1]!)
    const diff = Math.abs(((t.trackDeg - routeBrg + 540) % 360) - 180) // 0 = same direction, 180 = opposite
    out.push({ target: t, distNm, offRouteNm, dir: diff <= 90 ? 1 : -1 })
  }
  return out
}
