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

import { openMeteoJson, snapCoord, currentExpiresAt } from './openMeteo'
import { registerPersistedCache, markCacheDirty } from './persistedCache'

export interface WindAloft {
  /** Wind FROM direction in degrees true (meteorological convention). */
  dirDeg: number
  /** Wind speed in knots. */
  speedKts: number
}

/** Below this AMSL altitude (ft), use the surface (10 m) observation instead of a pressure level. */
export const SURFACE_THRESHOLD_FT = 1000

/** Map altitude (ft) to the nearest STANDARD Open-Meteo pressure level (hPa). */
export function pressureLevelFor(altFt: number): number {
  if (altFt <= 2000)  return 1000
  if (altFt <= 4500)  return 925
  if (altFt <= 7500)  return 850
  if (altFt <= 12000) return 700
  if (altFt <= 16000) return 600
  if (altFt <= 20000) return 500
  return 400
}

/** Which wind fetchWind reads for `altFt`: 'surface' (10 m) or a pressure level in hPa. Stable while the aircraft stays in one level band. */
export function windLevelFor(altFt: number | null | undefined): string {
  return altFt == null || altFt <= SURFACE_THRESHOLD_FT ? 'surface' : String(pressureLevelFor(altFt))
}

/** Cached wind for a point, or null when not cached / expired. Synchronous: lets a map overlay paint what it already knows at once. */
export function peekWind(lat: number, lng: number, altFt: number | null | undefined): WindAloft | null {
  const useSurface = altFt == null || altFt <= SURFACE_THRESHOLD_FT
  return cacheGet(cacheKey(lat, lng, useSurface ? 'surface' : String(pressureLevelFor(altFt!))), false)
}

type CurrentJson = { current?: Record<string, number> } | { current?: Record<string, number> }[]

/** Points to request: one per 0.05 deg cell (see snapCoord), with the input
 *  indices each one answers. */
function groupBySnappedCell(points: { lat: number; lng: number }[], indices: number[]) {
  const cells = new Map<string, { lat: number; lng: number; idx: number[] }>()
  for (const i of indices) {
    const lat = snapCoord(points[i].lat), lng = snapCoord(points[i].lng)
    const k = `${lat}_${lng}`
    const c = cells.get(k)
    if (c) c.idx.push(i)
    else cells.set(k, { lat, lng, idx: [i] })
  }
  return [...cells.values()]
}

function batchParams(cells: { lat: number; lng: number }[]): URLSearchParams {
  const params = new URLSearchParams()
  params.set('latitude',  cells.map((c) => c.lat.toFixed(2)).join(','))
  params.set('longitude', cells.map((c) => c.lng.toFixed(2)).join(','))
  return params
}

/** Open-Meteo accepts many coordinates per request; keep each request bounded. */
const MAX_BATCH = 25

/**
 * Wind for many points at one altitude using as few requests as possible:
 * cached points are returned from the cache, the rest go out in a single
 * multi-coordinate Open-Meteo request (per MAX_BATCH). Entries are null where
 * the model returned nothing or the request failed, so one bad point or a
 * failed chunk never blanks the rest. Fills the same cache as fetchWind.
 */
export async function fetchWindMany(
  points: { lat: number; lng: number }[],
  altFt: number | null | undefined,
  baseUrl = '',
  signal?: AbortSignal,
): Promise<(WindAloft | null)[]> {
  const useSurface = altFt == null || altFt <= SURFACE_THRESHOLD_FT
  const hPa      = useSurface ? null : pressureLevelFor(altFt!)
  const speedVar = useSurface ? 'wind_speed_10m'     : `wind_speed_${hPa}hPa`
  const dirVar   = useSurface ? 'wind_direction_10m' : `wind_direction_${hPa}hPa`
  const level    = useSurface ? 'surface' : String(hPa)

  const out: (WindAloft | null)[] = points.map((p) => peekWind(p.lat, p.lng, altFt))
  const missing = groupBySnappedCell(points, out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0))

  for (let start = 0; start < missing.length; start += MAX_BATCH) {
    const cells = missing.slice(start, start + MAX_BATCH)
    const params = batchParams(cells)
    params.set('current', [speedVar, dirVar].join(','))
    params.set('wind_speed_unit', 'kn')
    params.set('forecast_days',   '1')
    params.set('timeformat',      'unixtime')
    try {
      const json = await openMeteoJson<CurrentJson>(`${baseUrl}/api/open-meteo/forecast?${params.toString()}`, signal)
      const list = Array.isArray(json) ? json : [json]
      cells.forEach((cell, k) => {
        const cur = list[k]?.current
        const speedKts = cur?.[speedVar]
        const dirDeg   = cur?.[dirVar]
        if (speedKts == null || dirDeg == null) return
        const result: WindAloft = { dirDeg: Math.round(dirDeg), speedKts: Math.round(speedKts) }
        cache.set(cacheKey(cell.lat, cell.lng, level), { result, expiresAt: currentExpiresAt(cur, Date.now()) })
        markCacheDirty('wind')
        for (const i of cell.idx) out[i] = result
      })
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      // Failed (throttled / offline): show the last known wind for these
      // points if it isn't too old; the next pan/zoom retries the rest.
      for (const cell of cells) {
        const stale = cacheGet(cacheKey(cell.lat, cell.lng, level), true)
        if (stale) for (const i of cell.idx) out[i] = stale
      }
    }
  }
  return out
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// Keyed by "lat_lng_level" (the 0.05 deg cell, see cacheKey; level is either
// "surface" or an hPa number). An entry expires when Open-Meteo's next
// 15-minute value is due (currentExpiresAt), at most 30 min after receipt.
// Prevents redundant API calls when the user opens the same leg panel
// repeatedly.
const cache = new Map<string, { result: WindAloft; expiresAt: number }>()

/** Expired entries are still served for this long, and only when a fetch
 *  fails (Open-Meteo throttled / offline). Short on purpose: an hours-old
 *  wind must not pass for the current one. Callers that need to tell the
 *  pilot (Virtual Radar) get that from the fetch outcome, not the value. */
const STALE_MAX_MS = 60 * 60 * 1000
// Kept across reloads / restarts once the app enables it (see persistedCache).
// Persisting never extends freshness: entries keep their absolute expiry.
registerPersistedCache('wind', cache, { keepAfterExpiryMs: STALE_MAX_MS, maxEntries: 3000 })

/** Keyed on the 0.05 deg cell the point falls in (see snapCoord). */
function cacheKey(lat: number, lng: number, level: string): string {
  return `${snapCoord(lat).toFixed(2)}_${snapCoord(lng).toFixed(2)}_${level}`
}

function cacheGet(key: string, allowStale: boolean): WindAloft | null {
  const hit = cache.get(key)
  if (!hit) return null
  const t = Date.now()
  if (t < hit.expiresAt) return hit.result
  if (allowStale && t < hit.expiresAt + STALE_MAX_MS) return hit.result
  if (t >= hit.expiresAt + STALE_MAX_MS) cache.delete(key)
  return null
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
  const cached = cacheGet(key, false)
  if (cached) return cached

  // Proxied in dev (Vite) and production (nginx): /api/open-meteo → https://api.open-meteo.com/v1
  const params = batchParams([{ lat: snapCoord(lat), lng: snapCoord(lng) }])
  params.set('current', [speedVar, dirVar].join(','))
  params.set('wind_speed_unit', 'kn')
  params.set('forecast_days',   '1')
  params.set('timeformat',      'unixtime')

  const url = `${baseUrl}/api/open-meteo/forecast?${params.toString()}`

  // Throttling / retries are handled by openMeteoJson. If it still fails, a
  // recent (expired) reading beats no wind at all.
  let json: { current?: Record<string, number> }
  try {
    json = await openMeteoJson<{ current?: Record<string, number> }>(url, signal)
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err
    const stale = cacheGet(key, true)
    if (stale) return stale
    throw err
  }

  const speedKts = json.current?.[speedVar]
  const dirDeg   = json.current?.[dirVar]

  if (speedKts == null || dirDeg == null) {
    throw new Error('Open-Meteo: missing wind fields in response')
  }

  const result: WindAloft = { dirDeg: Math.round(dirDeg), speedKts: Math.round(speedKts) }
  cache.set(key, { result, expiresAt: currentExpiresAt(json.current, Date.now()) })
  markCacheDirty('wind')
  return result
}

/** Standard pressure levels Open-Meteo serves, with their nominal ISA altitude (ft AMSL). */
/** Pressure levels per fetchWindLevels request (see the comment there). */
const MAX_ALOFT_LEVELS = 4

export const WIND_LEVELS: readonly { hPa: number; altFt: number }[] = [
  { hPa: 925, altFt: 2500 },
  { hPa: 850, altFt: 4800 },
  { hPa: 700, altFt: 9900 },
  { hPa: 600, altFt: 13800 },
  { hPa: 500, altFt: 18300 },
]

export interface WindAtLevel extends WindAloft {
  /** Nominal ISA altitude AMSL; 0 for the surface (10 m) reading, which charts should draw at the terrain elevation instead. */
  altFt: number
  surface?: boolean
}

/**
 * Surface (10 m) wind plus winds aloft at every standard level up to `maxAltFt` (plus the first level
 * above it, so the top of the chart still has a barb nearby) for many points,
 * in one multi-point, multi-level request per chunk. Entry i is the list of
 * levels (low to high) for points[i]; levels the model had no data for are
 * left out. Fills the same cache as fetchWind, so a level fetched here is
 * free for the map's wind overlay and the leg wind prefill.
 */
export async function fetchWindLevels(
  points: { lat: number; lng: number }[],
  maxAltFt: number,
  baseUrl = '',
  signal?: AbortSignal,
  /** Set to true when a request for these points failed (the result is then incomplete or partly stale). */
  outcome?: { failed: boolean },
): Promise<WindAtLevel[][]> {
  // At most MAX_ALOFT_LEVELS pressure levels: with the 10 m wind that is 10
  // variables, which Open-Meteo bills as one call per location (more than 10
  // bills proportionally more: 12 variables = 1.2 calls). Only charts topping
  // out above ~13 800 ft would have asked for the 500 hPa level.
  const wanted: { hPa: number; altFt: number }[] = []
  for (const l of WIND_LEVELS) {
    if (wanted.length >= MAX_ALOFT_LEVELS) break
    wanted.push(l)
    if (l.altFt >= maxAltFt) break
  }
  const readLevels = (p: { lat: number; lng: number }, allowStale = false): WindAtLevel[] => {
    const out: WindAtLevel[] = []
    const sfc = cacheGet(cacheKey(p.lat, p.lng, 'surface'), allowStale)
    if (sfc) out.push({ ...sfc, altFt: 0, surface: true })
    for (const l of wanted) {
      const hit = cacheGet(cacheKey(p.lat, p.lng, String(l.hPa)), allowStale)
      if (hit) out.push({ ...hit, altFt: l.altFt })
    }
    return out
  }
  const missing = groupBySnappedCell(points, points
    .map((p, i) => (readLevels(p).length === wanted.length + 1 ? -1 : i))
    .filter((i) => i >= 0))

  // Points whose request failed fall back to recent (expired) readings.
  const failed = new Set<number>()
  for (let start = 0; start < missing.length; start += MAX_BATCH) {
    const cells = missing.slice(start, start + MAX_BATCH)
    const params = batchParams(cells)
    params.set('current', ['wind_speed_10m', 'wind_direction_10m', ...wanted.flatMap((l) => [`wind_speed_${l.hPa}hPa`, `wind_direction_${l.hPa}hPa`])].join(','))
    params.set('wind_speed_unit', 'kn')
    params.set('forecast_days',   '1')
    params.set('timeformat',      'unixtime')
    try {
      const json = await openMeteoJson<CurrentJson>(`${baseUrl}/api/open-meteo/forecast?${params.toString()}`, signal)
      const list = Array.isArray(json) ? json : [json]
      cells.forEach((pt, k) => {
        const cur = list[k]?.current
        if (!cur) return
        if (cur['wind_speed_10m'] != null && cur['wind_direction_10m'] != null) {
          markCacheDirty('wind')
          cache.set(cacheKey(pt.lat, pt.lng, 'surface'), {
            result: { dirDeg: Math.round(cur['wind_direction_10m']), speedKts: Math.round(cur['wind_speed_10m']) },
            expiresAt: currentExpiresAt(cur, Date.now()),
          })
        }
        for (const l of wanted) {
          const speedKts = cur[`wind_speed_${l.hPa}hPa`]
          const dirDeg   = cur[`wind_direction_${l.hPa}hPa`]
          if (speedKts == null || dirDeg == null) continue
          const result: WindAloft = { dirDeg: Math.round(dirDeg), speedKts: Math.round(speedKts) }
          cache.set(cacheKey(pt.lat, pt.lng, String(l.hPa)), { result, expiresAt: currentExpiresAt(cur, Date.now()) })
          markCacheDirty('wind')
        }
      })
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      if (outcome) outcome.failed = true
      for (const cell of cells) for (const i of cell.idx) failed.add(i)
    }
  }
  return points.map((p, i) => readLevels(p, failed.has(i)))
}

// \u2500\u2500 Ambient (non-aviation) weather-station tier \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Powers the Wx tab's "Weather station" toggle option (AerodromePopup.tsx /
// AerodromeWxSection.tsx) -- a second, always-available source distinct
// from METAR, explicitly modelled (Open-Meteo forecast "current" block),
// not an observed report. Surface-only (no altitude bands, unlike
// fetchWind above -- this always represents "weather at this spot right
// now", the ground-level non-aviation reading a pilot would otherwise get
// from a generic weather app). Deliberately separate from fetchWind's own
// cache/function: fetchWind's WindAloft is altitude-band-aware and reused
// by several altitude-dependent callers (VirtualRadar, wind-arrows layer,
// GoFlyingPanel); this is a simpler, always-surface, wider-variable-set
// reading with its own purpose and cache key.

export interface AmbientWx {
  /** Wind FROM direction in degrees true. Null when calm (speed 0). */
  dirDeg:      number | null
  speedKts:    number
  gustKts:     number | null
  tempC:       number | null
  cloudPct:    number | null
  /** Station-level surface pressure, hPa -- NOT a sea-level-reduced QNH
   *  (Open-Meteo's current block has no QNH-equivalent field). Labelled
   *  as "surface pressure" wherever rendered, never presented as QNH. */
  pressureHpa: number | null
  precipMm:    number | null
  /** Distance (NM) from the requested point to the model grid cell Open-Meteo
   *  actually sampled (its response's own latitude/longitude, snapped to the
   *  model grid -- typically a few km). Null when the response omits them. */
  gridDistNm:  number | null
}

/** Haversine distance in NM (kept local: routeCalc.ts pulls in the WMM package). */
function gcDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const ambientCache = new Map<string, { result: AmbientWx; expiresAt: number }>()
registerPersistedCache('ambientWx', ambientCache, { keepAfterExpiryMs: STALE_MAX_MS, maxEntries: 300 })

function ambientCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)}_${lng.toFixed(2)}`
}

export async function fetchAmbientWx(
  lat: number,
  lng: number,
  baseUrl = '',
  signal?: AbortSignal,
): Promise<AmbientWx> {
  const key    = ambientCacheKey(lat, lng)
  const cached = ambientCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  const vars = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'cloud_cover', 'surface_pressure', 'precipitation']
  // Not snapped: requested at the aerodrome's own (fixed) coordinates, which
  // are already stable across users, and gridDistNm reports the distance to
  // the model cell actually sampled.
  const params = new URLSearchParams()
  params.set('latitude',  lat.toFixed(4))
  params.set('longitude', lng.toFixed(4))
  params.set('current', vars.join(','))
  params.set('wind_speed_unit', 'kn')
  params.set('forecast_days',   '1')
  params.set('timeformat',      'unixtime')

  const url = `${baseUrl}/api/open-meteo/forecast?${params.toString()}`

  let json: { current: Record<string, number>; latitude?: number; longitude?: number }
  try {
    json = await openMeteoJson<typeof json>(url, signal)
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err
    if (cached && Date.now() < cached.expiresAt + STALE_MAX_MS) return cached.result
    throw err
  }
  const speedKts = json.current['wind_speed_10m']
  const dirDegRaw = json.current['wind_direction_10m']
  if (speedKts == null || dirDegRaw == null) {
    throw new Error('Open-Meteo: missing wind fields in response')
  }

  const result: AmbientWx = {
    dirDeg:      speedKts === 0 ? null : Math.round(dirDegRaw),
    speedKts:    Math.round(speedKts),
    gustKts:     json.current['wind_gusts_10m']  != null ? Math.round(json.current['wind_gusts_10m'])  : null,
    tempC:       json.current['temperature_2m']  != null ? Math.round(json.current['temperature_2m'])  : null,
    cloudPct:    json.current['cloud_cover']      != null ? Math.round(json.current['cloud_cover'])      : null,
    pressureHpa: json.current['surface_pressure'] != null ? Math.round(json.current['surface_pressure']) : null,
    precipMm:    json.current['precipitation']    != null ? json.current['precipitation']                : null,
    gridDistNm:  json.latitude != null && json.longitude != null ? gcDistNm(lat, lng, json.latitude, json.longitude) : null,
  }
  ambientCache.set(key, { result, expiresAt: currentExpiresAt(json.current, Date.now()) })
  markCacheDirty('ambientWx')
  return result
}
