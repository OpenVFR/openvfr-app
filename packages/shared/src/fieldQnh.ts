/**
 * fieldQnh — derive QNH from the phone barometer while parked at a known
 * aerodrome, as a fallback when no METAR is reachable (offline, remote
 * field). Uses the published field elevation as ground truth, so it has no
 * GPS vertical-accuracy error.
 */

import { qnhFromStationPressure } from './baroAltitude'

const FT_PER_M = 3.28084
/** Must be this close to the aerodrome reference point to trust its elevation. */
export const FIELD_QNH_MAX_DIST_NM = 1.0
/** Must be (almost) stationary: taxiing/flying changes height above the field. */
export const FIELD_QNH_MAX_SPEED_KTS = 3
const MIN_PLAUSIBLE_HPA = 940
const MAX_PLAUSIBLE_HPA = 1080

export type FieldQnhInput = {
  pressureHpa: number
  elevationFt: number
  distanceNm:  number
  speedKts:    number
}

/** QNH (hPa) implied by a parked-at-field pressure reading, or null when the
 *  conditions don't hold or the result is implausible. */
export function fieldQnhCandidate(i: FieldQnhInput): number | null {
  if (!(i.pressureHpa > 0) || !Number.isFinite(i.elevationFt)) return null
  if (i.distanceNm > FIELD_QNH_MAX_DIST_NM || i.speedKts > FIELD_QNH_MAX_SPEED_KTS) return null
  const qnh = qnhFromStationPressure(i.pressureHpa * 100, i.elevationFt / FT_PER_M)
  return qnh >= MIN_PLAUSIBLE_HPA && qnh <= MAX_PLAUSIBLE_HPA ? qnh : null
}
