/**
 * lookahead — horizontal sample points used to ask "will the aircraft be
 * inside this airspace soon?" Shared by the web and native alert hooks.
 *
 * Straight-line projection alone misses two cases:
 *  - a boundary just off the nose: a modest turn puts the aircraft inside
 *    before the track has changed enough for the projection to notice, so
 *    the path is sampled as a fan of ±FAN_DEG around the track;
 *  - GPS horizontal error: a fix reported N m from the truth can sit outside
 *    a boundary the aircraft is already inside, so the current position is
 *    also sampled at the reported accuracy radius (bounded, so a wildly
 *    inaccurate fix does not light up every airspace in the county).
 * Everything here errs towards warning early; the hooks' "inside now" state
 * is still taken from the reported position only.
 */

import { advancePosition } from './routeCalc'

export type LatLng = { lat: number; lng: number }

export const LOOKAHEAD_SAMPLES   = 5
export const LOOKAHEAD_FAN_DEG   = 15
/** Accuracy below this is ignored (normal GNSS noise); above MAX it is clamped. */
export const ACCURACY_MIN_M      = 30
export const ACCURACY_MAX_M      = 300
const M_PER_NM = 1852

/** Points along the projected path: on-track at N fractions of the distance,
 *  plus ±fan at half and full distance. */
export function lookaheadPath(lat: number, lng: number, trackDeg: number, distNm: number): LatLng[] {
  const pts: LatLng[] = []
  for (let i = 1; i <= LOOKAHEAD_SAMPLES; i++) pts.push(advancePosition(lat, lng, trackDeg, distNm * (i / LOOKAHEAD_SAMPLES)))
  for (const sign of [-1, 1]) {
    const brg = (trackDeg + sign * LOOKAHEAD_FAN_DEG + 360) % 360
    pts.push(advancePosition(lat, lng, brg, distNm * 0.5))
    pts.push(advancePosition(lat, lng, brg, distNm))
  }
  return pts
}

/** Points on the GPS accuracy circle around the current fix (4 cardinal),
 *  empty when the fix is accurate enough to trust as-is. */
export function accuracyRing(lat: number, lng: number, accuracyM: number): LatLng[] {
  if (!(accuracyM > ACCURACY_MIN_M)) return []
  const rNm = Math.min(accuracyM, ACCURACY_MAX_M) / M_PER_NM
  return [0, 90, 180, 270].map((brg) => advancePosition(lat, lng, brg, rNm))
}
