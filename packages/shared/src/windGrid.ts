/**
 * windGrid — samples wind (via fetchWind, Open-Meteo, keyless) across a
 * coarse lat/lng grid spanning a map viewport, for an ambient "wind arrows"
 * overlay (SkyDemon/EasyVFR-style winds-aloft arrows) — as opposed to the
 * single-point wind used by VirtualRadar/GaugesBar or the surface METAR wind
 * used by AerodromePopup's runway highlight.
 *
 * Deliberately grid-based, not per-airport: fetching METAR for every visible
 * airport just to draw arrows would be expensive and only gives surface
 * wind (not useful en-route at altitude). A capped grid keeps Open-Meteo
 * request volume bounded regardless of how many airports are on screen —
 * fetchWind's own 30-minute cache (keyed by rounded lat/lng + pressure
 * level) further dedupes repeat requests as the same area is re-fetched on
 * every pan/zoom.
 */

import { fetchWind, type WindAloft } from './fetchWind'

export interface WindGridPoint extends WindAloft {
  lat: number
  lng: number
}

export interface LatLngBounds {
  west: number
  south: number
  east: number
  north: number
}

/** Points per side (gridSize × gridSize total). Clamped to protect Open-Meteo's free tier. */
const DEFAULT_GRID_SIZE = 4
const MAX_GRID_SIZE = 6

/**
 * Fetches a gridSize×gridSize sample of wind across `bounds` at `altFt`
 * (null/undefined = surface wind, same convention as fetchWind itself).
 * Individual point failures (timeout, transient 5xx) are dropped rather
 * than failing the whole grid — a partially-filled arrow overlay is far
 * better than none for a should-never-block map feature like this.
 */
export async function fetchWindGrid(
  bounds: LatLngBounds,
  altFt: number | null,
  opts: { baseUrl?: string; gridSize?: number; signal?: AbortSignal } = {},
): Promise<WindGridPoint[]> {
  const gridSize = Math.max(2, Math.min(opts.gridSize ?? DEFAULT_GRID_SIZE, MAX_GRID_SIZE))
  const { west, south, east, north } = bounds

  const points: { lat: number; lng: number }[] = []
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const lng = west + (east - west) * ((i + 0.5) / gridSize)
      const lat = south + (north - south) * ((j + 0.5) / gridSize)
      points.push({ lat, lng })
    }
  }

  const settled = await Promise.allSettled(
    points.map((p) =>
      fetchWind(p.lat, p.lng, altFt, opts.baseUrl, opts.signal).then((w): WindGridPoint => ({ ...w, lat: p.lat, lng: p.lng })),
    ),
  )

  return settled
    .filter((r): r is PromiseFulfilledResult<WindGridPoint> => r.status === 'fulfilled')
    .map((r) => r.value)
}
