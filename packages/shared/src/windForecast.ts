/**
 * Forecast wind for a point / altitude / TIME (Open-Meteo hourly series).
 *
 * Mirrors SkyDemon's model: wind is a function of (time, position, level),
 * evaluated for the planned takeoff time + time into the flight, never frozen
 * into the leg. A manual per-leg override (handled by the caller) wins.
 *
 * Same level selection as fetchWind (10 m surface <= 1000 ft, else the
 * standard pressure level). Wind is linearly interpolated between the two
 * bracketing forecast hours as u/v vectors.
 */

import { fetchWithRetry } from './fetchWithRetry'
import { pressureLevelFor, SURFACE_THRESHOLD_FT, type WindAloft } from './fetchWind'

/** Open-Meteo forecast horizon (days). Beyond this there is no data. */
export const MAX_FORECAST_DAYS = 16

const CACHE_TTL_MS = 30 * 60 * 1000
const HOUR_S = 3600

interface Series { times: number[]; speed: number[]; dir: number[]; expiresAt: number }
const cache = new Map<string, Series>()

/** Drop cached series so the next fetch hits the API (manual "update wind"). */
export function clearWindForecastCache(): void { cache.clear() }

export interface WindForecastPoint {
  lat: number
  lng: number
  altFt: number | null | undefined
  /** Time the aircraft is at this point. */
  at: Date
}

/** True when `at` is inside the range Open-Meteo can forecast (now-1d .. now+16d). */
export function isForecastable(at: Date, now = Date.now()): boolean {
  const dt = at.getTime() - now
  return dt < MAX_FORECAST_DAYS * 86_400_000 && dt > -86_400_000
}

/** Interpolate wind (FROM dir, speed) at unix second `t` from an hourly series. Null when `t` is outside it. */
export function interpolateWind(series: Pick<Series, 'times' | 'speed' | 'dir'>, t: number): WindAloft | null {
  const { times, speed, dir } = series
  if (times.length === 0) return null
  let i = -1
  for (let k = 0; k < times.length; k++) { if (times[k] <= t) i = k; else break }
  if (i < 0 || (i === times.length - 1 && t - times[i] > HOUR_S)) return null
  const j = Math.min(i + 1, times.length - 1)
  const f = j === i ? 0 : (t - times[i]) / (times[j] - times[i])
  const vec = (k: number) => {
    const r = (dir[k] * Math.PI) / 180
    return { u: -speed[k] * Math.sin(r), v: -speed[k] * Math.cos(r) }
  }
  if (speed[i] == null || dir[i] == null || speed[j] == null || dir[j] == null) return null
  const a = vec(i), b = vec(j)
  const u = a.u + (b.u - a.u) * f
  const v = a.v + (b.v - a.v) * f
  const spd = Math.hypot(u, v)
  const d = spd < 0.05 ? dir[i] : ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360
  return { dirDeg: Math.round(d) % 360, speedKts: Math.round(spd) }
}

async function loadSeries(
  lat: number, lng: number, altFt: number | null | undefined, at: Date,
  baseUrl: string, signal?: AbortSignal,
): Promise<Series | null> {
  const useSurface = altFt == null || altFt <= SURFACE_THRESHOLD_FT
  const level = useSurface ? 'surface' : String(pressureLevelFor(altFt!))
  const speedVar = useSurface ? 'wind_speed_10m' : `wind_speed_${level}hPa`
  const dirVar   = useSurface ? 'wind_direction_10m' : `wind_direction_${level}hPa`
  const nowS = Date.now() / 1000
  const tS = at.getTime() / 1000
  const days = Math.min(MAX_FORECAST_DAYS, Math.max(2, Math.ceil((tS - nowS) / 86_400) + 2))
  const key = `${lat.toFixed(2)}_${lng.toFixed(2)}_${level}_${days}`
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit

  const params = new URLSearchParams()
  params.set('latitude',  lat.toFixed(4))
  params.set('longitude', lng.toFixed(4))
  params.set('hourly', `${speedVar},${dirVar}`)
  params.set('wind_speed_unit', 'kn')
  params.set('forecast_days', String(days))
  params.set('past_days', '1')
  params.set('timeformat', 'unixtime')
  const res = await fetchWithRetry(`${baseUrl}/api/open-meteo/forecast?${params.toString()}`, { signal })
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  const json = await res.json() as { hourly?: Record<string, number[]> }
  const h = json.hourly
  if (!h?.time || !h[speedVar] || !h[dirVar]) return null
  const series: Series = { times: h.time, speed: h[speedVar], dir: h[dirVar], expiresAt: Date.now() + CACHE_TTL_MS }
  cache.set(key, series)
  return series
}

/** Forecast wind for one point at its own time. Null when out of horizon / no data. Throws on network failure. */
export async function fetchWindForecast(
  p: WindForecastPoint, baseUrl = '', signal?: AbortSignal,
): Promise<WindAloft | null> {
  if (!isForecastable(p.at)) return null
  const series = await loadSeries(p.lat, p.lng, p.altFt, p.at, baseUrl, signal)
  return series ? interpolateWind(series, p.at.getTime() / 1000) : null
}

/** Forecast wind for many points (e.g. leg midpoints), concurrently. Entry null where unavailable or failed. */
export async function fetchWindForecastMany(
  points: WindForecastPoint[], baseUrl = '', signal?: AbortSignal,
): Promise<(WindAloft | null)[]> {
  return Promise.all(points.map(async (p) => {
    try { return await fetchWindForecast(p, baseUrl, signal) }
    catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      return null
    }
  }))
}
