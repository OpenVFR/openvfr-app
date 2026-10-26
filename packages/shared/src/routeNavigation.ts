/**
 * In-flight route navigation: which leg the aircraft is flying, and how a
 * "direct to" / shortcut rewrites the working route. Framework-agnostic and
 * shared by web and native.
 *
 * Leg selection is position based rather than an index that steps forward
 * when the aircraft comes within some radius of the next waypoint. A
 * radius-based index never advances when a turning point is passed wide or a
 * corner is cut, and goes stale after any route edit. Picking the leg that is
 * geometrically closest (current track breaking near-ties) needs no state, so
 * shortcuts, removed waypoints and re-planning all just work.
 */
import type { RouteWaypoint } from './routeCalc'
import type { LegOverride } from './types'

type LatLng = { lat: number; lng: number }

const NM_PER_DEG_LAT = 60

/** Two route points closer than this are treated as the same place. */
export const SAME_POINT_NM = 0.1

/**
 * Proximity difference under which two legs count as equally close; the
 * current track then picks the leg. Matters at turning points (both legs at
 * ~0 NM) and on routes that double back on themselves.
 */
const TIE_NM = 0.05

/**
 * Local flat-earth projection (NM) centred on `origin`. Error is negligible
 * at the tens-of-miles scale this is used for, and far legs only need to rank
 * as "far", not be measured precisely.
 */
function toLocal(origin: LatLng, p: LatLng): { x: number; y: number } {
  const cos = Math.cos((origin.lat * Math.PI) / 180)
  let dLng = p.lng - origin.lng
  if (dLng > 180) dLng -= 360
  if (dLng < -180) dLng += 360
  return { x: dLng * cos * NM_PER_DEG_LAT, y: (p.lat - origin.lat) * NM_PER_DEG_LAT }
}

/** Distance (NM) from `p` to the segment a→b. */
export function distanceToSegmentNm(p: LatLng, a: LatLng, b: LatLng): number {
  return projectOnSegment(p, a, b).d
}

/** Distance (NM) from `p` to segment a→b, and where along it (0 = a, 1 = b) the closest point lies. */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): { d: number; t: number } {
  const A = toLocal(p, a)
  const B = toLocal(p, b)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const lenSq = dx * dx + dy * dy
  // p is the origin, so the projection parameter is (-A)·(B-A) / |B-A|².
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (-A.x * dx - A.y * dy) / lenSq))
  return { d: Math.hypot(A.x + t * dx, A.y + t * dy), t }
}

function distNm(a: LatLng, b: LatLng): number {
  const p = toLocal(a, b)
  return Math.hypot(p.x, p.y)
}

/** True course (deg) of leg a→b in the local projection. */
function legTrackDeg(a: LatLng, b: LatLng): number {
  const B = toLocal(a, b)
  return ((Math.atan2(B.x, B.y) * 180) / Math.PI + 360) % 360
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** True when two points are within SAME_POINT_NM of each other. */
export function samePoint(a: LatLng, b: LatLng, tolNm = SAME_POINT_NM): boolean {
  return distNm(a, b) < tolNm
}

/**
 * Index of the leg (0-based, leg i = waypoints[i] → waypoints[i + 1]) the
 * aircraft is flying, or -1 without a route. The closest leg wins. When the
 * two closest legs are within TIE_NM of each other:
 *  - consecutive legs with the aircraft at or past the end of the first one:
 *    the turning point has been reached, so the next leg (needed after a
 *    sharp turn such as a direct-to behind, where both legs stay equally
 *    close while the aircraft is still flying the old track);
 *  - otherwise the leg whose course is nearer the current track (the earlier
 *    leg without a usable track).
 */
export function navigatingLeg(
  waypoints: RouteWaypoint[],
  pos: LatLng,
  trackDeg?: number | null,
): number {
  if (waypoints.length < 2) return -1
  let best = -1
  let bestD = Infinity
  let second = -1
  let secondD = Infinity
  const along: number[] = []
  for (let i = 0; i < waypoints.length - 1; i++) {
    const { d, t } = projectOnSegment(pos, waypoints[i], waypoints[i + 1])
    along.push(t)
    if (d < bestD) {
      second = best; secondD = bestD
      best = i; bestD = d
    } else if (d < secondD) {
      second = i; secondD = d
    }
  }
  if (second < 0 || secondD - bestD >= TIE_NM) return best
  const first = Math.min(best, second)
  const later = Math.max(best, second)
  if (later === first + 1 && along[first] >= 1) return later
  if (trackDeg == null || !Number.isFinite(trackDeg)) return best
  const diffBest = angleDiff(legTrackDeg(waypoints[best], waypoints[best + 1]), trackDeg)
  const diffSecond = angleDiff(legTrackDeg(waypoints[second], waypoints[second + 1]), trackDeg)
  return diffSecond < diffBest ? second : best
}

/**
 * Index of the waypoint ahead of `activeLeg` whose position matches `target`
 * (a turning point further along the route), or -1.
 */
export function shortcutTargetIndex(waypoints: RouteWaypoint[], activeLeg: number, target: LatLng): number {
  if (activeLeg < 0) return -1
  for (let j = activeLeg + 1; j < waypoints.length; j++) {
    if (samePoint(waypoints[j], target)) return j
  }
  return -1
}

export type RouteDirectKind =
  /** Target is a turning point further along: the legs before it are skipped. */
  | 'shortcut'
  /** Target lies near a leg ahead: fly to it, then rejoin the route after it. */
  | 'divert'
  /** Target replaces the rest of the route. */
  | 'direct'
  /** No route was being flown: a new one from the present position. */
  | 'new'

export interface RouteDirectInput {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  /** Leg being flown (navigatingLeg), -1 if none. */
  activeLeg: number
  position: LatLng
  target: RouteWaypoint
  /**
   * Allow rejoining the route after a target that is not on it (a reporting
   * point or other en-route fix). Leave false for destinations such as
   * aerodromes, which end the route.
   */
  rejoin?: boolean
  /** Maximum distance (NM) from a leg ahead for `rejoin` to apply. */
  rejoinMaxNm?: number
  /** Name given to the inserted present-position point. */
  positionName?: string
}

export interface RouteDirectResult {
  kind: RouteDirectKind
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  /** Leg now being flown (starts at the present position, ends at the target). */
  activeLeg: number
}

/**
 * Rewrites the working route so the aircraft flies from its present position
 * to `target`. Legs already flown (before the active leg) are kept, together
 * with their per-leg overrides, so the route still describes the whole
 * flight; the new present-position leg inherits the active leg's overrides
 * (level, speed, wind).
 */
export function routeDirect(input: RouteDirectInput): RouteDirectResult {
  const { waypoints: wps, legOverrides: ovr, activeLeg: L, position, target } = input
  const posWp: RouteWaypoint = { lat: position.lat, lng: position.lng, name: input.positionName ?? 'Position' }

  if (wps.length < 2 || L < 0 || L > wps.length - 2) {
    return { kind: 'new', waypoints: [posWp, target], legOverrides: [{}], activeLeg: 0 }
  }

  const inherited = ovr[L] ?? {}
  // Flown part: up to and including the active leg's start, then the present
  // position -- unless the aircraft is still at that start, which would leave
  // a zero-length leg.
  const atStart = samePoint(wps[L], position)
  const headWps = atStart ? wps.slice(0, L + 1) : [...wps.slice(0, L + 1), posWp]
  const headOvr = atStart ? ovr.slice(0, L) : [...ovr.slice(0, L), inherited]
  const fromLeg = headWps.length - 1

  const j = shortcutTargetIndex(wps, L, target)
  if (j >= 0) {
    return {
      kind: 'shortcut',
      waypoints: [...headWps, ...wps.slice(j)],
      legOverrides: [...headOvr, inherited, ...ovr.slice(j)].slice(0, headWps.length + wps.length - j - 1),
      activeLeg: fromLeg,
    }
  }

  if (input.rejoin) {
    const maxNm = input.rejoinMaxNm ?? 5
    let k = -1
    let kd = Infinity
    for (let i = L; i < wps.length - 1; i++) {
      const d = distanceToSegmentNm(target, wps[i], wps[i + 1])
      if (d < kd) { kd = d; k = i }
    }
    if (k >= 0 && kd <= maxNm && !samePoint(wps[k + 1], target)) {
      return {
        kind: 'divert',
        waypoints: [...headWps, target, ...wps.slice(k + 1)],
        legOverrides: [...headOvr, inherited, ovr[k] ?? {}, ...ovr.slice(k + 1)].slice(0, headWps.length + wps.length - k - 1),
        activeLeg: fromLeg,
      }
    }
  }

  return {
    kind: 'direct',
    waypoints: [...headWps, target],
    legOverrides: [...headOvr, inherited],
    activeLeg: fromLeg,
  }
}
