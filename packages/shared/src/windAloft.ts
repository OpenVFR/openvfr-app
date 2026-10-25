/**
 * windAloft — wind at several flight levels at regular intervals along a
 * route, for the Virtual Radar (barbs at several altitudes above the route,
 * so the pilot can see at a glance which level has the best wind). One multi-level Open-Meteo request covers the whole route.
 */

import { fetchWindLevels, type WindAtLevel } from './fetchWind'
import { openMeteoCooldownMs } from './openMeteo'
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

/** Retries of an incomplete route wind fetch, and the least wait before each. */
const FOLLOW_UP_RETRIES = 3
const FOLLOW_UP_MIN_MS = 30_000

/**
 * Calls `onColumns` with the route's winds aloft, and again (up to
 * FOLLOW_UP_RETRIES times) if part of ITS request failed -- Open-Meteo
 * throttled or the network dropped -- once Open-Meteo lets requests through
 * again (never sooner than FOLLOW_UP_MIN_MS). Only the points still missing
 * are requested again (the rest come from fetchWind's cache). Stop it by
 * aborting `signal`.
 *
 * `status` says whether what was delivered is complete: 'ok', 'retrying'
 * (incomplete, another attempt is scheduled) or 'unavailable' (incomplete,
 * retries used up -- the next route change tries again).
 */
export type WindAloftStatus = 'ok' | 'retrying' | 'unavailable'

export function watchWindAloftAlongRoute(
  waypoints: { lat: number; lng: number }[],
  totalNm: number,
  maxAltFt: number,
  baseUrl: string,
  signal: AbortSignal,
  tickStepNm: number,
  onColumns: (columns: WindAloftColumn[], status: WindAloftStatus) => void,
): void {
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  const load = () => {
    // Only this route's own requests count: a failure elsewhere in the app
    // (the map's wind overlay, the wind gauge, a leg forecast) used to mark
    // complete route winds as "retrying" too.
    const outcome = { failed: false }
    fetchWindAloftAlongRoute(waypoints, totalNm, maxAltFt, baseUrl, signal, tickStepNm, outcome)
      .then((c) => {
        if (signal.aborted) return
        if (!outcome.failed) { onColumns(c, 'ok'); return }
        if (retries++ < FOLLOW_UP_RETRIES) {
          onColumns(c, 'retrying')
          timer = setTimeout(load, Math.max(FOLLOW_UP_MIN_MS, openMeteoCooldownMs()))
        } else {
          onColumns(c, 'unavailable')
        }
      })
      .catch(() => { /* aborted */ })
  }
  load()
}

export async function fetchWindAloftAlongRoute(
  waypoints: { lat: number; lng: number }[],
  totalNm: number,
  maxAltFt: number,
  baseUrl = '',
  signal?: AbortSignal,
  tickStepNm = 0,
  outcome?: { failed: boolean },
): Promise<WindAloftColumn[]> {
  if (waypoints.length < 2 || totalNm <= 0) return []
  const distances = nudgeOffTicks(regularIntervalDistances(totalNm, COLUMN_INTERVAL_NM, MAX_COLUMNS), totalNm, tickStepNm)
  if (distances.length === 0) return []
  const pts = distances.map((d) => coordinateAlongRouteNm(waypoints, d))
  const levels = await fetchWindLevels(pts, maxAltFt, baseUrl, signal, outcome)
  return distances.map((distNm, i) => ({ distNm, levels: levels[i] })).filter((c) => c.levels.length > 0)
}
