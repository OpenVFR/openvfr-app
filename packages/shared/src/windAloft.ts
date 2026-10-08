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

export async function fetchWindAloftAlongRoute(
  waypoints: { lat: number; lng: number }[],
  totalNm: number,
  maxAltFt: number,
  baseUrl = '',
  signal?: AbortSignal,
): Promise<WindAloftColumn[]> {
  if (waypoints.length < 2 || totalNm <= 0) return []
  const distances = regularIntervalDistances(totalNm, COLUMN_INTERVAL_NM, MAX_COLUMNS)
  if (distances.length === 0) return []
  const pts = distances.map((d) => coordinateAlongRouteNm(waypoints, d))
  const levels = await fetchWindLevels(pts, maxAltFt, baseUrl, signal)
  return distances.map((distNm, i) => ({ distNm, levels: levels[i] })).filter((c) => c.levels.length > 0)
}
