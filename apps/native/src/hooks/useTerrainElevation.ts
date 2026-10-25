/**
 * useTerrainElevation — live single-point ground elevation lookup for the
 * current GPS position, used to compute height above ground (GPS HGT) in GaugesBar.
 *
 * Source: the downloaded hillshade DEM first, else the elevation API.
 *
 * Throttled: only re-fetches when the position has moved more than
 * MIN_MOVE_NM or MIN_INTERVAL_MS has elapsed, to avoid spamming OpenTopoData
 * on every GPS tick (1 Hz).
 */

import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'
import type { GpsPosition } from '../utils/gpsTypes'
import { pointElevationFt } from '@open-vfr/shared/pointElevation'
import { getOfflineDem } from '../utils/terrainDem'
import { authHeaders } from '../utils/authClient'

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

    const { lat, lng } = position
    // Downloaded DEM first, API where it has none (@open-vfr/shared/pointElevation).
    // API_BASE, not TILE_BASE -- /api/elevation/ is proxied by the api
    // server, a different host from TILE_BASE (which in production points
    // at the R2 tiles bucket domain). Using TILE_BASE here hit the R2 bucket
    // with a bogus path and came back with a 401 misreported as
    // "OpenTopoData HTTP 401" (found 2026-09-20).
    pointElevationFt(lat, lng, { dem: getOfflineDem(), baseUrl: API_BASE, headers: authHeaders })
      // Nothing answered: terrain stays unknown (the sample goes stale).
      .then((ft) => { if (ft != null) setSample({ elevFt: ft, lat, lng, at: Date.now() }) })
      .finally(() => { inFlightRef.current = false })
  }, [position])

  if (!sample || !position) return null
  if (Date.now() - sample.at > STALE_AGE_MS) return null
  if (quickDistNm(sample.lat, sample.lng, position.lat, position.lng) > STALE_DIST_NM) return null
  return sample.elevFt
}
