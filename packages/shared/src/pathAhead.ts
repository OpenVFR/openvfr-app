/**
 * pathAhead: the path the in-flight vertical profile shows -- what lies ahead
 * of the aircraft, with the aircraft near the left edge.
 *
 *  - On the planned route (within ON_ROUTE_ENTER_NM, kept until more than
 *    ON_ROUTE_LEAVE_NM off it): the remaining route from the aircraft,
 *    turns included, so the ground, airspace and obstacles after the next
 *    waypoint are already on the chart. Each profile leg remembers which
 *    route leg it is part of (for the planned levels).
 *  - Off the route, past its end, or without one: a straight line along the
 *    current track.
 *
 * Length: AHEAD_MINUTES at the current ground speed, at least AHEAD_MIN_NM,
 * plus a short stretch behind the aircraft (max(BEHIND_MIN_NM, BEHIND_SHARE
 * of the length)) so it does not sit on the very edge. Showing the whole
 * planned route instead (A to B, aircraft moving along it) is the hosts'
 * choice; in flight it was misleading as soon as the aircraft left the route.
 *
 * nextPathAhead() decides when to rebuild: every rebuild changes the chart's
 * route, which fetches terrain again, so small movements reuse the last path
 * (the hosts keep the aircraft marker moving along it).
 */

import { advancePosition, bearingDeg, distanceNm, type RouteWaypoint } from './routeCalc'
import { coordinateAlongRouteNm, distanceAlongRouteNm, routeCrossTrackNm } from './virtualRadarCalc'

export const AHEAD_MINUTES      = 12
export const AHEAD_MIN_NM       = 10
export const BEHIND_MIN_NM      = 1
export const BEHIND_SHARE       = 0.05
export const ON_ROUTE_ENTER_NM  = 1
export const ON_ROUTE_LEAVE_NM  = 2
/** Rebuild when the aircraft has moved this far from where the path was built ... */
export const REBUILD_MOVE_NM    = 0.5
/** ... or (straight path) its track changed this much ... */
export const REBUILD_TRACK_DEG  = 5
/** ... or this long passed. */
export const REBUILD_MAX_AGE_MS = 20_000

export interface AheadPosition { lat: number; lng: number; trackDeg: number; speedKts: number }

export interface PathAhead {
  /** The profile's route: first point behind the aircraft, last point ahead. */
  waypoints: RouteWaypoint[]
  /** Following the planned route (bends at its waypoints) vs. straight along the track. */
  onRoute: boolean
  /** Per profile leg (waypoints[i] -> waypoints[i+1]): the planned route leg it lies on; -1 when not on the route. */
  routeLegOf: number[]
  /** Track of the straight path (deg); for a path on the route, the track at the aircraft. */
  trackDeg: number
}

/** Cumulative great-circle distance (NM) at each route waypoint. */
function cumulativeNm(route: readonly RouteWaypoint[]): number[] {
  const out = [0]
  for (let i = 1; i < route.length; i++) out.push(out[i - 1]! + distanceNm(route[i - 1]!, route[i]!))
  return out
}

/** The path ahead for `pos`; `wasOnRoute` gives the on/off-route decision its hysteresis. */
export function pathAhead(route: readonly RouteWaypoint[], pos: AheadPosition, wasOnRoute: boolean): PathAhead {
  const lengthNm = Math.max(AHEAD_MIN_NM, (Math.max(0, pos.speedKts) * AHEAD_MINUTES) / 60)
  const behindNm = Math.max(BEHIND_MIN_NM, lengthNm * BEHIND_SHARE)

  if (route.length >= 2) {
    const cum = cumulativeNm(route)
    const total = cum[cum.length - 1]!
    const along = distanceAlongRouteNm(route as RouteWaypoint[], pos)
    const xt = routeCrossTrackNm(route as RouteWaypoint[], pos)
    // Past the destination the route has nothing ahead left to show.
    const onRoute = xt <= (wasOnRoute ? ON_ROUTE_LEAVE_NM : ON_ROUTE_ENTER_NM) && along < total - 0.05
    if (onRoute) {
      const start = Math.max(0, along - behindNm)
      const end = Math.min(total, along + lengthNm)
      const legAt = (nm: number) => { let i = 0; while (i < route.length - 2 && cum[i + 1]! <= nm) i++; return i }
      const waypoints: RouteWaypoint[] = [{ ...coordinateAlongRouteNm(route as RouteWaypoint[], start), name: '' }]
      const routeLegOf: number[] = []
      for (let i = 1; i < route.length - 1; i++) {
        if (cum[i]! > start && cum[i]! < end) {
          routeLegOf.push(i - 1)
          waypoints.push(route[i]!)
        }
      }
      routeLegOf.push(legAt(Math.max(start, end - 1e-6)))
      const last = end >= total - 1e-6 ? route[route.length - 1]! : { ...coordinateAlongRouteNm(route as RouteWaypoint[], end), name: '' }
      waypoints.push(last)
      const leg = legAt(along)
      return { waypoints, onRoute: true, routeLegOf, trackDeg: bearingDeg(route[leg]!, route[leg + 1]!) }
    }
  }

  const back = advancePosition(pos.lat, pos.lng, (pos.trackDeg + 180) % 360, behindNm)
  const ahead = advancePosition(pos.lat, pos.lng, pos.trackDeg, lengthNm)
  return {
    waypoints: [
      { lat: back.lat, lng: back.lng, name: '' },
      { lat: ahead.lat, lng: ahead.lng, name: `Hdg ${Math.round(pos.trackDeg)}°` },
    ],
    onRoute: false,
    routeLegOf: [-1],
    trackDeg: pos.trackDeg,
  }
}

/** What the hosts keep between fixes. */
export interface PathAheadState {
  path: PathAhead
  /** Where and when it was built. */
  at: { lat: number; lng: number; trackDeg: number; ts: number }
  /** The planned route it was built for (identity). */
  route: readonly RouteWaypoint[]
}

/**
 * The state for this fix: `prev` when the path still serves, else a rebuilt
 * one. Rebuilds after REBUILD_MOVE_NM, REBUILD_MAX_AGE_MS, a planned-route
 * change, an on/off-route change, or (straight path only) a track change of
 * REBUILD_TRACK_DEG.
 */
export function nextPathAhead(
  prev: PathAheadState | null,
  route: readonly RouteWaypoint[],
  pos: AheadPosition,
  nowMs: number,
): PathAheadState {
  if (prev && prev.route === route) {
    const moved = distanceNm(prev.at, pos)
    const dTrk = Math.abs(((pos.trackDeg - prev.at.trackDeg + 540) % 360) - 180)
    const fresh = moved < REBUILD_MOVE_NM && nowMs - prev.at.ts < REBUILD_MAX_AGE_MS
      && (prev.path.onRoute || dTrk < REBUILD_TRACK_DEG)
    if (fresh) {
      // Leaving / rejoining the route rebuilds at once, not at the next threshold.
      const probe = route.length >= 2 ? pathAhead(route, pos, prev.path.onRoute).onRoute : false
      if (probe === prev.path.onRoute) return prev
    }
  }
  return {
    path: pathAhead(route, pos, prev?.path.onRoute ?? false),
    at: { lat: pos.lat, lng: pos.lng, trackDeg: pos.trackDeg, ts: nowMs },
    route,
  }
}

/**
 * Planned levels for the path's legs: each profile leg takes the setting of
 * the route leg it lies on -- also when that leg has none (undefined), so the
 * chart uses the same default level as the route's own profile; legs off the
 * route take `offRoute` (the current altitude and speed, so the chart's level
 * line follows the aircraft).
 */
export function pathAheadLegOverrides<T>(path: PathAhead, routeOverrides: readonly (T | undefined)[], offRoute: T): (T | undefined)[] {
  return path.routeLegOf.map(i => (i >= 0 ? routeOverrides[i] : offRoute))
}

/**
 * Elevations the planned-level line starts and ends at. A route starts and
 * ends on the ground (its first / last terrain sample); a path ahead starts
 * (and, unless it reaches the destination, ends) in the air, so those ends
 * take the first / last planned level instead -- otherwise the chart draws a
 * climb from the ground under an aircraft already at its level.
 */
export function plannedLineEnds(
  groundStartFt: number,
  groundEndFt: number,
  altitudeProfile: readonly { altFt: number }[],
  airborne: { start: boolean; end: boolean } | undefined,
): { startFt: number; endFt: number } {
  const first = altitudeProfile[0]?.altFt
  const last = altitudeProfile[altitudeProfile.length - 1]?.altFt
  return {
    startFt: airborne?.start && first != null ? first : groundStartFt,
    endFt: airborne?.end && last != null ? last : groundEndFt,
  }
}
