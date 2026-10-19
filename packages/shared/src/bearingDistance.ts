import { advancePosition, magDeclination } from './routeCalc'

/**
 * "Bearing and distance from a reference" search syntax, e.g. `EGLL 270 10`,
 * `EGLL/270/10`, `EGLL R270 D10NM`, `Hangar 090/4.5`. The bearing is magnetic.
 */
export interface BearingDistanceQuery {
  ref: string
  bearingMag: number
  distNm: number
}

const RE = /^(.+?)[\s/]+R?(\d{1,3})\s*°?[\s/]+D?(\d+(?:\.\d+)?)\s*(?:NM)?$/i

export function parseBearingDistance(q: string): BearingDistanceQuery | null {
  const m = RE.exec(q.trim())
  if (!m) return null
  const ref = m[1].trim()
  const bearingMag = Number(m[2])
  const distNm = Number(m[3])
  if (!ref || bearingMag > 360 || !(distNm > 0) || distNm > 2000) return null
  return { ref, bearingMag: bearingMag % 360, distNm }
}

/** Point `distNm` from `from` along the given magnetic bearing. */
export function pointFromBearingDistance(
  from: { lat: number; lng: number },
  bearingMag: number,
  distNm: number,
): { lat: number; lng: number } {
  const decl = magDeclination(from.lat, from.lng)
  return advancePosition(from.lat, from.lng, (bearingMag + decl + 360) % 360, distNm)
}

/** e.g. "270° M / 10 NM from EGLL" */
export function describeBearingDistance(q: BearingDistanceQuery, refLabel: string): string {
  const b = String(Math.round(q.bearingMag) % 360).padStart(3, '0')
  const d = Number.isInteger(q.distNm) ? String(q.distNm) : q.distNm.toFixed(1)
  return `${b}°M / ${d} NM from ${refLabel}`
}
