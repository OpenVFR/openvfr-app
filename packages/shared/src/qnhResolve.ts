/**
 * qnhResolve — pure QNH policy shared by the phone-barometer and BlueFly
 * altitude paths: METAR parsing sanity, source priority, staleness and the
 * "QNH stepped, restart the vertical-speed filter" rule.
 */

export const MIN_PLAUSIBLE_QNH_HPA = 940
export const MAX_PLAUSIBLE_QNH_HPA = 1080
/** An auto QNH result older than this is no longer trusted. */
export const QNH_MAX_AGE_MS = 3 * 60 * 60_000
/** …nor one fetched this far from the current position. */
export const QNH_MAX_DIST_NM = 100
/** A QNH step above this restarts a vertical-speed filter (altitude jumps in one step). */
export const QNH_RESET_DELTA_HPA = 0.5

const HPA_PER_INHG = 33.8639

/** Decode a METAR QNH token ("Q1013" hPa or "A2992" inHg*100) to hPa.
 *  Returns null for unparsable or implausible values. */
export function qnhTokenToHpa(tok: string): number | null {
  let hpa: number
  if (tok.startsWith('Q')) hpa = Number(tok.slice(1))
  else if (tok.startsWith('A')) hpa = (Number(tok.slice(1)) / 100) * HPA_PER_INHG
  else return null
  return Number.isFinite(hpa) && hpa >= MIN_PLAUSIBLE_QNH_HPA && hpa <= MAX_PLAUSIBLE_QNH_HPA ? hpa : null
}

export function isQnhResultStale(ageMs: number, distNm: number): boolean {
  return ageMs > QNH_MAX_AGE_MS || distNm > QNH_MAX_DIST_NM
}

export function qnhStepNeedsReset(prevHpa: number | null, nextHpa: number): boolean {
  return prevHpa != null && Math.abs(nextHpa - prevHpa) > QNH_RESET_DELTA_HPA
}

export type ResolvedQnh = {
  qnhHpa: number
  /** false when qnhHpa is only the stored/default fallback under auto mode. */
  calibrated: boolean
}

/** Priority in auto mode: METAR > field calibration > stored value (uncalibrated).
 *  Manual mode always uses the stored value and counts as calibrated. */
export function resolveQnh(input: {
  auto:      boolean
  metarHpa:  number | null
  fieldHpa:  number | null
  storedHpa: number
}): ResolvedQnh {
  if (!input.auto) return { qnhHpa: input.storedHpa, calibrated: true }
  const live = input.metarHpa ?? input.fieldHpa
  return live != null ? { qnhHpa: live, calibrated: true } : { qnhHpa: input.storedHpa, calibrated: false }
}
