/**
 * useTerrainElevation — live single-point ground elevation lookup for the
 * current GPS position, used to compute Height AGL (T.ALT AGL) in GaugesBar.
 *
 * Throttled: only re-fetches when the position has moved more than
 * MIN_MOVE_NM or MIN_INTERVAL_MS has elapsed, to avoid spamming OpenTopoData
 * on every GPS tick (1 Hz).
 */

import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'
import type { GpsPosition } from '../utils/gpsTypes'
import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'
import { getOfflineDem } from '../utils/terrainDem'

const MIN_MOVE_NM     = 0.3
const MIN_INTERVAL_MS = 15_000
// A sample no longer describes the ground under the aircraft once it has
// moved this far from where it was taken, or after this long (offline, API
// down). Returning null then is safer than a frozen value: consumers (AGL
// gauge, AGL airspace limits) fall back to "terrain unknown".
const STALE_DIST_NM   = 3
const STALE_AGE_MS    = 5 * 60_000

type Sample = { elevFt: number; lat: number; lng: number; at: number }

function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

export function useTerrainElevation(position: GpsPosition | null): number | null {
  const [sample, setSample] = useState<Sample | null>(null)
  const lastFetchRef = useRef<{ lat: number; lng: number; at: number } | null>(null)
  const inFlightRef   = useRef(false)

  useEffect(() => {
    if (!position) return
    const last = lastFetchRef.current
    const now  = Date.now()
    if (last) {
      const movedNm = quickDistNm(last.lat, last.lng, position.lat, position.lng)
      if (movedNm < MIN_MOVE_NM && (now - last.at) < MIN_INTERVAL_MS) return
    }
    if (inFlightRef.current) return
    inFlightRef.current = true
    lastFetchRef.current = { lat: position.lat, lng: position.lng, at: now }

    const params = new URLSearchParams({ locations: `${position.lat.toFixed(5)},${position.lng.toFixed(5)}` })
    // Retries transient network blips / 502-504 -- see fetchWithRetry.ts.
    // Also self-heals via the next GPS-driven effect run (MIN_INTERVAL_MS)
    // even if a request exhausts its retries, so a brief gap never leaves
    // AGL stuck stale for long.
    // API_BASE, not TILE_BASE -- /api/elevation/ is proxied by the api
    // server's nginx, a different host from TILE_BASE (which in production
    // points at the R2 tiles bucket domain). Using TILE_BASE here hit the
    // R2 bucket with a bogus path and came back with a 401 misreported as
    // "OpenTopoData HTTP 401" (found 2026-09-20).
    fetchWithRetry(`${API_BASE}/api/elevation/eudem25m?${params.toString()}`)
      .then(r => r.json())
      .then((data: { results?: { elevation: number | null }[]; status?: string }) => {
        if (data.status !== 'OK' || !data.results?.[0]) return
        const m = data.results[0].elevation
        if (m != null) setSample({ elevFt: Math.round(m * 3.28084), lat: position.lat, lng: position.lng, at: Date.now() })
      })
      .catch(async () => {
        // API unreachable: fall back to the DEM, else terrain stays unknown.
        const dem = getOfflineDem()
        if (!dem) return
        const ft = await dem.elevationFt(position.lat, position.lng).catch(() => null)
        if (ft != null) setSample({ elevFt: ft, lat: position.lat, lng: position.lng, at: Date.now() })
      })
      .finally(() => { inFlightRef.current = false })
  }, [position])

  if (!sample || !position) return null
  if (Date.now() - sample.at > STALE_AGE_MS) return null
  if (quickDistNm(sample.lat, sample.lng, position.lat, position.lng) > STALE_DIST_NM) return null
  return sample.elevFt
}
