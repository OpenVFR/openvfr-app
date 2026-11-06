/**
 * How hard the app asks the device for a position, by what the pilot is doing.
 *
 * GNSS is one of the biggest drains on a tablet or phone, and a foreground
 * service keeps the app alive in the background. Asking for a 1 Hz best-accuracy
 * fix with a service from launch to the moment the app is swiped away (planning
 * at the kitchen table, then the bag, then the car) is wasteful: the service
 * notification says "tracking flight" while nothing flies, and the receiver runs
 * for hours. So the request follows the situation:
 *
 *   flight         flying (GPS or a simulator-free flight): best accuracy at
 *                  1 Hz, with a foreground service so recording and the moving
 *                  map survive a locked screen.
 *   ground-active  not flying but moving (taxi, or the app has just opened /
 *                  returned to the foreground): best accuracy at 1 Hz, no
 *                  service. The 2 minutes after opening keep a takeoff that
 *                  starts right away (or an app opened in the air) fast to detect.
 *   ground-idle    stationary: balanced accuracy every 10 s (a position dot is
 *                  all that is needed), no service, and nothing at all while the
 *                  app is in the background.
 *
 * Pure functions; the platform glue is in apps/native (tasks/locationTask.ts,
 * hooks/useGps.ts).
 */

export type GpsTier = 'flight' | 'ground-active' | 'ground-idle'

export interface GpsRequestSpec {
  accuracy: 'best' | 'balanced'
  timeIntervalMs: number
  distanceIntervalM: number
  /** A foreground service (Android) / background location (iOS): fixes keep coming with the screen off. */
  foregroundService: boolean
}

export const GPS_REQUESTS: Record<GpsTier, GpsRequestSpec> = {
  'flight':        { accuracy: 'best',     timeIntervalMs: 1_000,  distanceIntervalM: 0,  foregroundService: true },
  'ground-active': { accuracy: 'best',     timeIntervalMs: 1_000,  distanceIntervalM: 0,  foregroundService: false },
  'ground-idle':   { accuracy: 'balanced', timeIntervalMs: 10_000, distanceIntervalM: 15, foregroundService: false },
}

/** At or above this ground speed (kt) the device counts as moving. */
export const MOVING_KTS = 4
/** After the last movement (or after opening the app) the fast tier is kept this long. */
export const ACTIVE_HOLD_MS = 120_000
/** A balanced fix jitters by tens of metres: a displacement only counts as movement beyond this. */
export const MIN_MOVE_M = 50

export function gpsTier(input: { flying: boolean; lastMovedAtMs: number | null; nowMs: number }): GpsTier {
  if (input.flying) return 'flight'
  if (input.lastMovedAtMs != null && input.nowMs - input.lastMovedAtMs < ACTIVE_HOLD_MS) return 'ground-active'
  return 'ground-idle'
}

export interface GpsFixLike { lat: number; lng: number; speedKts: number; accuracyM: number; tMs: number }

const M_PER_DEG = 111_320

function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * M_PER_DEG
  const dLng = (b.lng - a.lng) * M_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLng)
}

/**
 * Whether a new fix shows the device moving: its own speed, or (a balanced fix
 * carries no reliable speed) a displacement from the previous fix larger than
 * the position jitter, at a speed that is not a walk.
 */
export function isMoving(prev: GpsFixLike | null, fix: GpsFixLike): boolean {
  if (fix.speedKts >= MOVING_KTS) return true
  if (!prev) return false
  const dtS = (fix.tMs - prev.tMs) / 1000
  if (dtS <= 0) return false
  const d = distM(prev, fix)
  const noise = Math.max(MIN_MOVE_M, 2 * Math.max(prev.accuracyM, fix.accuracyM))
  if (d < noise) return false
  return (d / dtS) * 1.943844 >= MOVING_KTS
}
