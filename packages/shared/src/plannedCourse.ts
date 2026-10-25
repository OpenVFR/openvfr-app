/**
 * Is the aircraft flying the planned route right now?
 *
 * Airspace the route was planned through is already known to the pilot, so
 * repeating a yellow warning for it all along the leg is noise. "On the
 * planned course" means: moving, within `maxXtkNm` of a leg, between that
 * leg's ends, and tracking within `maxTrackDiffDeg` of the leg's bearing.
 */
import type { RouteWaypoint } from './types'

export const COURSE_MAX_XTK_NM = 1
export const COURSE_MAX_TRACK_DIFF_DEG = 30
export const COURSE_MIN_SPEED_KTS = 30
/** Allowed overshoot past a leg end, NM (turn points, GPS error). */
const END_SLACK_NM = 0.5
const NM_PER_DEG = 60

export function onPlannedCourse(
  own: { lat: number; lng: number; trackDeg: number; speedKts: number },
  waypoints: readonly Pick<RouteWaypoint, 'lat' | 'lng'>[],
  maxXtkNm: number = COURSE_MAX_XTK_NM,
  maxTrackDiffDeg: number = COURSE_MAX_TRACK_DIFF_DEG,
): boolean {
  if (waypoints.length < 2 || !(own.speedKts >= COURSE_MIN_SPEED_KTS)) return false
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1]
    const cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
    const legN = (b.lat - a.lat) * NM_PER_DEG
    const legE = (b.lng - a.lng) * NM_PER_DEG * cos
    const len = Math.hypot(legN, legE)
    if (len < 0.1) continue
    const ownN = (own.lat - a.lat) * NM_PER_DEG
    const ownE = (own.lng - a.lng) * NM_PER_DEG * cos
    const along = (ownE * legE + ownN * legN) / len
    const xtk = Math.abs(ownE * legN - ownN * legE) / len
    if (xtk > maxXtkNm || along < -END_SLACK_NM || along > len + END_SLACK_NM) continue
    const legBrg = (Math.atan2(legE, legN) * 180 / Math.PI + 360) % 360
    const diff = Math.abs(((own.trackDeg - legBrg + 540) % 360) - 180)
    if (diff <= maxTrackDiffDeg) return true
  }
  return false
}
