/**
 * Carrying on a flight log the app could not finish.
 *
 * When the app is closed or stopped (by the user, the system, a crash) while
 * a log is open, the next start finds that log unfinished. Closing it at once
 * splits a flight in two whenever the app restarts between circuits or in the
 * air. Instead, the unfinished log is kept open for a short while: a takeoff
 * (or, in the air, the first fast fix) close to where it ended continues it,
 * with the time in between recorded as a gap. Anything else closes it.
 *
 *   - Parked when it ended (last point slower than the landed speed): it may
 *     be continued for the log split timeout, like a normal stop between
 *     circuits, by a takeoff within LOG_RESUME_PARKED_NM of where it stood.
 *     With "Per leg" (timeout 0) it never is.
 *   - Flying when it ended: for LOG_RESUME_AIRBORNE_MS (the same 10 minutes
 *     as joining two parts of a flight), by a fix within the distance the
 *     aircraft could have flown in between (LOG_RESUME_NM_PER_MIN) plus
 *     LOG_RESUME_PARKED_NM.
 */
import { MERGE_MAX_GAP_MS } from './flightLogRoute'

export const LOG_RESUME_PARKED_NM = 2
export const LOG_RESUME_AIRBORNE_MS = MERGE_MAX_GAP_MS
/** 180 kt: generous for light aircraft. */
export const LOG_RESUME_NM_PER_MIN = 3

export interface ResumePoint { lat: number; lng: number; spdKts: number; ts: number }

function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** Until when (ms) an unfinished log ending at `last` may be continued; 0 = not at all. */
export function resumableUntil(last: ResumePoint, landedKts: number, parkTimeoutMs: number): number {
  if (last.spdKts < landedKts) return parkTimeoutMs > 0 ? last.ts + parkTimeoutMs : 0
  return last.ts + LOG_RESUME_AIRBORNE_MS
}

/** True when a takeoff / fast fix `now` continues the unfinished log that ended at `last`. */
export function canResumeLog(
  last: ResumePoint, now: { lat: number; lng: number; ts: number }, landedKts: number, parkTimeoutMs: number,
): boolean {
  if (now.ts < last.ts || now.ts > resumableUntil(last, landedKts, parkTimeoutMs)) return false
  const d = distNm(last, now)
  if (last.spdKts < landedKts) return d <= LOG_RESUME_PARKED_NM
  return d <= LOG_RESUME_PARKED_NM + LOG_RESUME_NM_PER_MIN * (now.ts - last.ts) / 60_000
}
