/**
 * pointElevation — ground elevation (ft AMSL) at one point, for the live
 * "terrain under the aircraft" lookups of web and native (useTerrainElevation).
 *
 * The DEM first: it is asked every ~15 s in flight, which through the
 * elevation API would use up the shared budget (per-user hourly cap) within
 * minutes. The API -- which itself answers from the server's copy of the same
 * DEM when OpenTopoData can't -- only without a DEM or where it has no data.
 */

import { fetchWithRetry } from './fetchWithRetry'
import type { ElevationLookup } from './terrainDem'

const FT_PER_M = 3.28084

export async function pointElevationFt(
  lat: number,
  lng: number,
  opts: {
    /** Web: the remote hillshade DEM; native: the downloaded one, or null. */
    dem: ElevationLookup | null
    /** API origin, e.g. API_BASE_URL (web) / API_BASE (native) -- not the tile host. */
    baseUrl: string
    /** Extra request headers (native: the session's Authorization). Web relies on the cookie. */
    headers?: () => Promise<Record<string, string>>
  },
): Promise<number | null> {
  if (opts.dem) {
    const ft = await opts.dem.elevationFt(lat, lng).catch(() => null)
    if (ft != null) return ft
  }
  try {
    const params = new URLSearchParams({ locations: `${lat.toFixed(5)},${lng.toFixed(5)}` })
    const headers = opts.headers ? await opts.headers() : undefined
    // Retries transient network blips / 502-504 only; a 429/503 is not asked
    // again here -- the caller's next GPS-driven run retries.
    const r = await fetchWithRetry(`${opts.baseUrl}/api/elevation/eudem25m?${params.toString()}`, headers ? { headers } : undefined, { retryStatuses: [502, 504] })
    if (!r.ok) return null
    const data = await r.json() as { results?: { elevation: number | null }[]; status?: string }
    const m = data.status === 'OK' ? data.results?.[0]?.elevation : null
    return m == null ? null : Math.round(m * FT_PER_M)
  } catch {
    return null
  }
}

/** Points sampled around the position by areaMaxElevationFt: centre, and two rings. */
function areaPoints(lat: number, lng: number, radiusM: number): [number, number][] {
  const dLat = radiusM / 111_320
  const dLng = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180))
  const pts: [number, number][] = [[lat, lng]]
  for (const f of [0.5, 1]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      pts.push([lat + f * dLat * Math.cos(a), lng + f * dLng * Math.sin(a)])
    }
  }
  return pts
}

/**
 * Highest ground (ft AMSL) within about `radiusM` of a point: the centre and
 * 16 points on two rings. A cautious "terrain" for deciding whether a fix is
 * in the air: a road along a valley, on an embankment or a bridge sits below
 * the highest ground around it, so a margin above this does not mistake it
 * for flight. One elevation API request (multi-point) when there is no DEM.
 * null when nothing answered.
 */
export async function areaMaxElevationFt(
  lat: number,
  lng: number,
  radiusM: number,
  opts: Parameters<typeof pointElevationFt>[2],
): Promise<number | null> {
  const pts = areaPoints(lat, lng, radiusM)
  if (opts.dem) {
    const vals = await Promise.all(pts.map(([a, b]) => opts.dem!.elevationFt(a, b).catch(() => null)))
    const ok = vals.filter((v): v is number => v != null)
    if (ok.length > 0) return Math.max(...ok)
  }
  try {
    const params = new URLSearchParams({ locations: pts.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join('|') })
    const headers = opts.headers ? await opts.headers() : undefined
    const r = await fetchWithRetry(`${opts.baseUrl}/api/elevation/eudem25m?${params.toString()}`, headers ? { headers } : undefined, { retryStatuses: [502, 504] })
    if (!r.ok) return null
    const data = await r.json() as { results?: { elevation: number | null }[]; status?: string }
    const ms = data.status === 'OK' ? (data.results ?? []).map(x => x.elevation).filter((v): v is number => v != null) : []
    return ms.length === 0 ? null : Math.round(Math.max(...ms) * FT_PER_M)
  } catch {
    return null
  }
}
