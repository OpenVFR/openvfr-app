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
