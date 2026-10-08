/**
 * windGrid — samples wind (Open-Meteo, keyless) on a world-anchored lattice
 * covering a map viewport, for the ambient "wind arrows" overlay — as opposed
 * to the single-point wind used by VirtualRadar/GaugesBar or the surface METAR
 * wind used by AerodromePopup's runway highlight.
 *
 * The lattice is anchored to the world (points at whole multiples of a "nice"
 * step), not to the viewport, and the step only changes in coarse tiers as the
 * view zooms. That gives three things the old viewport-relative grid lacked:
 *  - panning inside a tier reuses the same points, so most are already cached
 *    (fetchWind's 30-minute cache) and the barbs stay put instead of jumping;
 *  - a zoom change swaps the whole lattice to the next tier, so two grids of
 *    different spacing are never drawn together (the "rows and columns of
 *    barbs" clutter);
 *  - everything not cached is fetched in one multi-point request.
 */

import { fetchWindMany, peekWind, type WindAloft } from './fetchWind'

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

/** Max points per side the lattice may use (so at most N×N points). Clamped to protect Open-Meteo's free tier. */
const DEFAULT_GRID_SIZE = 6
const MAX_GRID_SIZE = 6

/** Candidate lattice steps in degrees of latitude, finest first. */
const NICE_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 45, 90]

/**
 * World-anchored lattice points inside `bounds`: the finest nice step that
 * keeps at most gridSize points per side. Longitude spacing is widened at
 * high latitude so the points look roughly square on the map.
 */
export function windLattice(bounds: LatLngBounds, gridSize: number = DEFAULT_GRID_SIZE): { lat: number; lng: number }[] {
  const n = Math.max(2, Math.min(gridSize, MAX_GRID_SIZE))
  const { west, south, east, north } = bounds
  const midLat = Math.max(-80, Math.min(80, (south + north) / 2))
  const lngFactor = Math.max(1, Math.min(4, Math.round(1 / Math.cos((midLat * Math.PI) / 180))))

  for (const step of NICE_STEPS) {
    const lngStep = step * lngFactor
    const lat0 = Math.ceil(south / step), lat1 = Math.floor(north / step)
    const lng0 = Math.ceil(west / lngStep), lng1 = Math.floor(east / lngStep)
    if (lat1 - lat0 + 1 > n || lng1 - lng0 + 1 > n) continue
    const pts: { lat: number; lng: number }[] = []
    for (let i = lat0; i <= lat1; i++) {
      for (let j = lng0; j <= lng1; j++) {
        pts.push({ lat: round4(i * step), lng: round4(j * lngStep) })
      }
    }
    // A step so fine that no lattice point falls inside a tiny viewport would
    // draw nothing: keep going to coarser steps only while empty.
    if (pts.length > 0) return pts
  }
  return []
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4

const toPoints = (pts: { lat: number; lng: number }[], winds: (WindAloft | null)[]): WindGridPoint[] =>
  pts.flatMap((p, i) => (winds[i] ? [{ ...winds[i]!, lat: p.lat, lng: p.lng }] : []))

/** The lattice points whose wind is already cached: available immediately, no network. */
export function cachedWindGrid(bounds: LatLngBounds, altFt: number | null, opts: { gridSize?: number } = {}): WindGridPoint[] {
  const pts = windLattice(bounds, opts.gridSize)
  return toPoints(pts, pts.map((p) => peekWind(p.lat, p.lng, altFt)))
}

/**
 * Wind at the lattice points for `bounds` at `altFt` (null/undefined = surface
 * wind, same convention as fetchWind). Points that could not be fetched are
 * dropped, so a partly filled overlay beats none. Throws only on abort.
 */
export async function fetchWindGrid(
  bounds: LatLngBounds,
  altFt: number | null,
  opts: { baseUrl?: string; gridSize?: number; signal?: AbortSignal } = {},
): Promise<WindGridPoint[]> {
  const pts = windLattice(bounds, opts.gridSize)
  return toPoints(pts, await fetchWindMany(pts, altFt, opts.baseUrl, opts.signal))
}
