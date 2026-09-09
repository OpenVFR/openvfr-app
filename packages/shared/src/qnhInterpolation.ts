/**
 * qnhInterpolation — distance-weighted QNH averaging across multiple nearby
 * METAR stations, rather than trusting a single nearest station's reading.
 *
 * QNH is already sea-level-reduced pressure by definition (that's the whole
 * point of QNH vs QFE) — station elevation plays no further role once a
 * METAR reports QNH, so only horizontal distance is weighted here, never
 * altitude/height.
 *
 * Inverse-distance weighting: closer stations count more, but every station
 * within range still contributes something — smooths out one station's
 * local pressure noise/reporting quirks compared to blindly trusting
 * whichever station happens to be nearest.
 */

export type QnhReading = {
  icao:    string
  distNm:  number
  qnhHpa:  number
}

export type QnhInterpolationResult = {
  qnhHpa: number
  /** Stations that actually contributed (sorted nearest-first), for UI transparency. */
  stations: string[]
}

const EPSILON_NM = 0.5  // avoids divide-by-zero / an unrealistically dominant weight for a station directly overhead

/**
 * Inverse-distance-weighted average QNH across all given readings.
 * Returns null if no readings are provided.
 */
export function interpolateQnh(readings: QnhReading[]): QnhInterpolationResult | null {
  if (readings.length === 0) return null

  const sorted = [...readings].sort((a, b) => a.distNm - b.distNm)

  let weightedSum = 0
  let weightTotal = 0
  for (const r of sorted) {
    const weight = 1 / (r.distNm + EPSILON_NM)
    weightedSum += weight * r.qnhHpa
    weightTotal += weight
  }

  return {
    qnhHpa:   weightedSum / weightTotal,
    stations: sorted.map(r => r.icao),
  }
}
