/**
 * Forecast wind for a point / altitude / TIME (Open-Meteo hourly series).
 *
 * Wind is a function of (time, position, level),
 * evaluated for the planned takeoff time + time into the flight, never frozen
 * into the leg. A manual per-leg override (handled by the caller) wins.
 *
 * Same level selection as fetchWind (10 m surface <= 1000 ft, else the
 * standard pressure level). Wind is linearly interpolated between the two
 * bracketing forecast hours as u/v vectors.
 */

import { openMeteoJson, snapCoord } from './openMeteo'
import { registerPersistedCache, markCacheDirty } from './persistedCache'
import { pressureLevelFor, SURFACE_THRESHOLD_FT, type WindAloft } from './fetchWind'

/** Open-Meteo forecast horizon (days). Beyond this there is no data. */
export const MAX_FORECAST_DAYS = 16

const CACHE_TTL_MS = 30 * 60 * 1000
const HOUR_S = 3600

interface Series { times: number[]; speed: number[]; dir: number[]; expiresAt: number }
const cache = new Map<string, Series>()
// Kept across reloads / restarts once the app enables it (see persistedCache).
// ~2-5 KB per series, hence the small cap.
registerPersistedCache('windForecast', cache, { keepAfterExpiryMs: 3 * 60 * 60 * 1000, maxEntries: 80 })

/** Drop cached series so the next fetch hits the API (manual "update wind"). */
export function clearWindForecastCache(): void { cache.clear(); markCacheDirty('windForecast') }

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

const MAX_BATCH = 25

function levelOf(altFt: number | null | undefined): { level: string; speedVar: string; dirVar: string } {
  const useSurface = altFt == null || altFt <= SURFACE_THRESHOLD_FT
  const level = useSurface ? 'surface' : String(pressureLevelFor(altFt!))
  return {
    level,
    speedVar: useSurface ? 'wind_speed_10m' : `wind_speed_${level}hPa`,
    dirVar:   useSurface ? 'wind_direction_10m' : `wind_direction_${level}hPa`,
  }
}

function forecastDays(at: Date): number {
  return Math.min(MAX_FORECAST_DAYS, Math.max(2, Math.ceil((at.getTime() / 1000 - Date.now() / 1000) / 86_400) + 2))
}

/** Keyed on the 0.05 deg cell (see snapCoord), which is also what is requested. */
function seriesKey(lat: number, lng: number, level: string, days: number): string {
  return `${snapCoord(lat).toFixed(2)}_${snapCoord(lng).toFixed(2)}_${level}_${days}`
}

/** An expired series is still used for this long, only when a fetch fails.
 *  It is a forecast for the leg's time from a model run at most ~3.5 h
 *  older than the newest -- the kind of age a briefing forecast has anyway. */
const STALE_MAX_MS = 3 * 60 * 60 * 1000

/**
 * Hourly series for many points at one level, as few requests as possible
 * (one multi-coordinate request per MAX_BATCH uncached points). Entry null
 * where the model returned nothing or the request failed with no recent
 * series to fall back on. Throws only on abort.
 */
async function loadSeriesMany(
  pts: { lat: number; lng: number }[], altFt: number | null | undefined, days: number,
  baseUrl: string, signal?: AbortSignal,
): Promise<(Series | null)[]> {
  const { level, speedVar, dirVar } = levelOf(altFt)
  const out: (Series | null)[] = pts.map((p) => {
    const hit = cache.get(seriesKey(p.lat, p.lng, level, days))
    return hit && Date.now() < hit.expiresAt ? hit : null
  })
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0)
  for (let start = 0; start < missing.length; start += MAX_BATCH) {
    const idx = missing.slice(start, start + MAX_BATCH)
    const params = new URLSearchParams()
    params.set('latitude',  idx.map((i) => snapCoord(pts[i].lat).toFixed(2)).join(','))
    params.set('longitude', idx.map((i) => snapCoord(pts[i].lng).toFixed(2)).join(','))
    params.set('hourly', `${speedVar},${dirVar}`)
    params.set('wind_speed_unit', 'kn')
    params.set('forecast_days', String(days))
    params.set('past_days', '1')
    params.set('timeformat', 'unixtime')
    type HourlyJson = { hourly?: Record<string, number[]> } | { hourly?: Record<string, number[]> }[]
    let json: HourlyJson
    try {
      json = await openMeteoJson<HourlyJson>(`${baseUrl}/api/open-meteo/forecast?${params.toString()}`, signal)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      for (const pi of idx) {
        const hit = cache.get(seriesKey(pts[pi].lat, pts[pi].lng, level, days))
        if (hit && Date.now() < hit.expiresAt + STALE_MAX_MS) out[pi] = hit
      }
      continue
    }
    const list = Array.isArray(json) ? json : [json]
    idx.forEach((pi, k) => {
      const h = list[k]?.hourly
      if (!h?.time || !h[speedVar] || !h[dirVar]) return
      const series: Series = { times: h.time, speed: h[speedVar], dir: h[dirVar], expiresAt: Date.now() + CACHE_TTL_MS }
      cache.set(seriesKey(pts[pi].lat, pts[pi].lng, level, days), series)
      markCacheDirty('windForecast')
      out[pi] = series
    })
  }
  return out
}

/** Forecast wind for one point at its own time. Null when out of horizon / no data. Throws on network failure. */
export async function fetchWindForecast(
  p: WindForecastPoint, baseUrl = '', signal?: AbortSignal,
): Promise<WindAloft | null> {
  return (await fetchWindForecastMany([p], baseUrl, signal))[0]
}

/**
 * Forecast wind for many points (e.g. leg midpoints), each at its own time and
 * altitude. Points are grouped by wind level and fetched in multi-coordinate
 * requests. Entry null where unavailable or the request failed (so one failed
 * level never blanks the rest); AbortError is rethrown.
 */
export async function fetchWindForecastMany(
  points: WindForecastPoint[], baseUrl = '', signal?: AbortSignal,
): Promise<(WindAloft | null)[]> {
  const out: (WindAloft | null)[] = points.map(() => null)
  const groups = new Map<string, number[]>()
  points.forEach((p, i) => {
    if (!isForecastable(p.at)) return
    const key = levelOf(p.altFt).level
    groups.set(key, [...(groups.get(key) ?? []), i])
  })
  await Promise.all([...groups.values()].map(async (idx) => {
    // One window per group, long enough for its latest time: keeps cache keys stable.
    const days = Math.max(...idx.map((i) => forecastDays(points[i].at)))
    try {
      const series = await loadSeriesMany(idx.map((i) => points[i]), points[idx[0]].altFt, days, baseUrl, signal)
      idx.forEach((i, k) => {
        const s = series[k]
        out[i] = s ? interpolateWind(s, points[i].at.getTime() / 1000) : null
      })
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
    }
  }))
  return out
}
