/**
 * lookaheadTerrain — keeps the look-ahead profile's ground line on screen
 * while the next one loads.
 *
 * In flight without a planned route, the vertical profile follows a
 * two-point route from the aircraft along its track, rebuilt every few
 * seconds. Each rebuild used to blank the ground line until the new terrain
 * arrived (and, on a slow link, the next rebuild could come first, so the
 * ground never showed). When the new route only slid forward along the same
 * line, the previous terrain already covers most of it: shift it by the
 * distance flown and keep showing it until the fresh samples arrive.
 *
 * Only for a continuation of the same line: after a turn, or a jump, the old
 * samples describe ground the aircraft is not heading over, and none is
 * better than wrong.
 */

import { bearingDeg, distanceNm } from './routeCalc'
import type { RouteWaypoint } from './types'
import type { TerrainPoint } from './virtualRadarCalc'

/** Largest track change for which the old samples still lie on the new line. */
export const CARRY_MAX_TRACK_DIFF_DEG = 3
/** Largest sideways offset of the new start from the old line. */
export const CARRY_MAX_OFFSET_NM = 0.3

/**
 * The previous look-ahead terrain re-based onto `next` (distances measured
 * from next's start; samples behind it dropped), or null when `next` is not
 * a forward continuation of `prev` on (nearly) the same line.
 */
export function carryLookaheadTerrain(
  prev: readonly RouteWaypoint[],
  prevPts: readonly TerrainPoint[],
  next: readonly RouteWaypoint[],
): TerrainPoint[] | null {
  if (prev.length !== 2 || next.length !== 2 || prevPts.length < 2) return null
  const [a, b] = prev as [RouteWaypoint, RouteWaypoint]
  const [c, d] = next as [RouteWaypoint, RouteWaypoint]
  const trackPrev = bearingDeg(a, b)
  const trackNext = bearingDeg(c, d)
  const dTrack = Math.abs(((trackNext - trackPrev + 540) % 360) - 180)
  if (dTrack > CARRY_MAX_TRACK_DIFF_DEG) return null
  // Where the new start lies relative to the old line.
  const dist = distanceNm(a, c)
  if (dist < 1e-6) return prevPts.map((p) => ({ ...p }))
  const rel = ((bearingDeg(a, c) - trackPrev) * Math.PI) / 180
  const along = dist * Math.cos(rel)
  const cross = Math.abs(dist * Math.sin(rel))
  if (along < 0 || cross > CARRY_MAX_OFFSET_NM) return null
  const i = prevPts.findIndex((p) => p.distNm >= along)
  if (i < 0) return null
  const kept = prevPts.slice(i).map((p) => ({ distNm: Math.round((p.distNm - along) * 100) / 100, elevFt: p.elevFt }))
  // Ground under the new start, interpolated between the samples either side of it.
  if (i > 0 && kept[0]!.distNm > 0) {
    const p0 = prevPts[i - 1]!, p1 = prevPts[i]!
    const f = (along - p0.distNm) / Math.max(1e-9, p1.distNm - p0.distNm)
    kept.unshift({ distNm: 0, elevFt: Math.round(p0.elevFt + f * (p1.elevFt - p0.elevFt)) })
  }
  // A sliver at the start is not worth showing as "the ground ahead".
  if (kept.length < 2 || kept[kept.length - 1]!.distNm < 0.5 * distanceNm(c, d)) return null
  return kept
}
