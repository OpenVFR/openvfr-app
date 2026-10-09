/**
 * windAloft — wind at several flight levels at regular intervals along a
 * route, for the Virtual Radar (SkyDemon-style: barbs at several altitudes
 * above the route, so the pilot can see at a glance which level has the best
 * wind). One multi-level Open-Meteo request covers the whole route.
 */

import { fetchWindLevels, type WindAtLevel } from './fetchWind'
import { coordinateAlongRouteNm, regularIntervalDistances } from './virtualRadarCalc'

export interface WindAloftColumn {
  /** Distance along the route (NM) the column was sampled at. */
  distNm: number
  /** Winds low to high; only levels up to just above the chart top. */
  levels: WindAtLevel[]
}

const COLUMN_INTERVAL_NM = 20
const MAX_COLUMNS = 8

/**
 * Move sample distances off the x-axis tick labels (ticks at multiples of
 * tickStepNm) so a column's ground barb isn't hidden by a tick label. Sample
 * positions are arbitrary, unlike a METAR's; only the nearest free spot is used.
 */
export function nudgeOffTicks(distances: number[], totalNm: number, tickStepNm: number): number[] {
  if (tickStepNm <= 0) return distances
  const clear = Math.min(totalNm * 0.07, tickStepNm / 3)
  const gap = (d: number) => {
    const r = d % tickStepNm
    return Math.min(r, tickStepNm - r)
  }
  return distances.map((d) => {
    if (gap(d) >= clear) return d
    for (let k = 1; k <= 12; k++) {
      for (const c of [d + (k * clear) / 3, d - (k * clear) / 3]) {
        if (c > clear && c < totalNm - clear && gap(c) >= clear) return Math.round(c * 10) / 10
      }
    }
    return d
  })
}

export async function fetchWindAloftAlongRoute(
  waypoints: { lat: number; lng: number }[],
  totalNm: number,
  maxAltFt: number,
  baseUrl = '',
  signal?: AbortSignal,
  tickStepNm = 0,
): Promise<WindAloftColumn[]> {
  if (waypoints.length < 2 || totalNm <= 0) return []
  const distances = nudgeOffTicks(regularIntervalDistances(totalNm, COLUMN_INTERVAL_NM, MAX_COLUMNS), totalNm, tickStepNm)
  if (distances.length === 0) return []
  const pts = distances.map((d) => coordinateAlongRouteNm(waypoints, d))
  const levels = await fetchWindLevels(pts, maxAltFt, baseUrl, signal)
  return distances.map((distNm, i) => ({ distNm, levels: levels[i] })).filter((c) => c.levels.length > 0)
}
