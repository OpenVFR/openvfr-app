/**
 * Fetches wind at a given lat/lng from the Open-Meteo forecast API
 * (https://open-meteo.com, free, no API key required).
 *
 * Uses one of two Open-Meteo variable sets depending on altitude:
 *
 *  - **Surface (10 m)**: `wind_speed_10m`/`wind_direction_10m` — used when
 *    `altFt` is unknown or ≤ 1,000 ft (i.e. on the ground, taxiing, or in
 *    the pattern). Surface friction slows and backs wind noticeably
 *    compared to just a few hundred feet up — using a pressure-level
 *    "winds aloft" reading here overstated real conditions by ~80% in a
 *    live comparison (16.6 kt aloft vs. 9.3 kt actual surface wind for the
 *    same spot/time), which is misleading for a gauge read while on the
 *    ground. This matches what a pilot would actually feel/see on a
 *    windsock.
 *  - **Pressure level (winds aloft)**: once actually airborne above
 *    1,000 ft, gradient-level wind is exactly what matters for navigation
 *    (WCA, groundspeed) — Open-Meteo only exposes wind at the STANDARD
 *    synoptic pressure levels (1000/925/850/700/600/500/400… hPa);
 *    requesting an intermediate level like 975/950/900/800 hPa returns
 *    hourly_units: "undefined" and null data for that variable silently
 *    (no HTTP error). Altitude bands:
 *
 *      ≤ 2 000 ft  → 1000 hPa (~360 ft)
 *      ≤ 4 500 ft  →  925 hPa (~2 500 ft)
 *      ≤ 7 500 ft  →  850 hPa (~4 800 ft)
 *      ≤ 12 000 ft →  700 hPa (~9 880 ft)
 *      ≤ 16 000 ft →  600 hPa (~13 800 ft)
 *      ≤ 20 000 ft →  500 hPa (~18 300 ft)
 *      > 20 000 ft  →  400 hPa (~23 600 ft)
 *
 * Returns wind FROM direction (°T, 0–359) and speed (knots).
 * Throws on network error or non-OK HTTP status.
 *
 * Shared between web and native. Pass baseUrl='' for web (relative URL via
 * Vite proxy / nginx same-origin); pass API_BASE for native.
 */

import { fetchWithRetry } from './fetchWithRetry'

export interface WindAloft {
  /** Wind FROM direction in degrees true (meteorological convention). */
  dirDeg: number
  /** Wind speed in knots. */
  speedKts: number
}

/** Below this AMSL altitude (ft), use the surface (10 m) observation instead of a pressure level. */
const SURFACE_THRESHOLD_FT = 1000

/** Map altitude (ft) to the nearest STANDARD Open-Meteo pressure level (hPa). */
function pressureLevelFor(altFt: number): number {
  if (altFt <= 2000)  return 1000
  if (altFt <= 4500)  return 925
  if (altFt <= 7500)  return 850
  if (altFt <= 12000) return 700
  if (altFt <= 16000) return 600
  if (altFt <= 20000) return 500
  return 400
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// Keyed by "lat_lng_level" (rounded to 2 dp ≈ 1 km grid; level is either
// "surface" or an hPa number). TTL: 30 minutes. Prevents redundant API
// calls when the user opens the same leg panel repeatedly.
const CACHE_TTL_MS = 30 * 60 * 1000
const cache = new Map<string, { result: WindAloft; expiresAt: number }>()

function cacheKey(lat: number, lng: number, level: string): string {
  return `${lat.toFixed(2)}_${lng.toFixed(2)}_${level}`
}

/**
 * Fetch wind at `lat`/`lng` for the given `altFt`.
 * If `altFt` is null/undefined the surface (10 m) reading is used — same
 * as being on the ground with an unknown/no GPS altitude fix yet.
 * The AbortSignal is forwarded so callers can cancel on component unmount.
 */
export async function fetchWind(
  lat: number,
  lng: number,
  altFt: number | null | undefined,
  baseUrl = '',
  signal?: AbortSignal,
): Promise<WindAloft> {
  const useSurface = altFt == null || altFt <= SURFACE_THRESHOLD_FT
  const hPa      = useSurface ? null : pressureLevelFor(altFt)
  const speedVar = useSurface ? 'wind_speed_10m'     : `wind_speed_${hPa}hPa`
  const dirVar   = useSurface ? 'wind_direction_10m' : `wind_direction_${hPa}hPa`

  // Return cached result if still fresh (avoids redundant API calls).
  const key    = cacheKey(lat, lng, useSurface ? 'surface' : String(hPa))
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  // Proxied in dev (Vite) and production (nginx): /api/open-meteo → https://api.open-meteo.com/v1
  const params = new URLSearchParams()
  params.set('latitude',  lat.toFixed(4))
  params.set('longitude', lng.toFixed(4))
  params.set('current', [speedVar, dirVar].join(','))
  params.set('wind_speed_unit', 'kn')
  params.set('forecast_days',   '1')
  params.set('timeformat',      'unixtime')

  const url = `${baseUrl}/api/open-meteo/forecast?${params.toString()}`

  // Retries transient network blips / 502-504 -- see fetchWithRetry.ts.
  const res = await fetchWithRetry(url, { signal })
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)

  const json = await res.json() as {
    current: Record<string, number>
  }

  const speedKts = json.current[speedVar]
  const dirDeg   = json.current[dirVar]

  if (speedKts == null || dirDeg == null) {
    throw new Error('Open-Meteo: missing wind fields in response')
  }

  const result: WindAloft = { dirDeg: Math.round(dirDeg), speedKts: Math.round(speedKts) }
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}
