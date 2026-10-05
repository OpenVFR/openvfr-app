/**
 * useTerrainElevation — live single-point ground elevation (ft AMSL) under
 * the current GPS position, for AGL airspace limits in the alert hooks.
 * Mirrors the native hook of the same name.
 *
 * Throttled: re-fetches only after MIN_MOVE_NM of movement or MIN_INTERVAL_MS.
 * A sample older than STALE_AGE_MS or taken more than STALE_DIST_NM away is
 * reported as null (terrain unknown) rather than a frozen value.
 */

import { useEffect, useRef, useState } from 'react'
import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'
import { getRemoteDem } from '../utils/terrainDem'
import type { GpsPosition } from '../utils/gpsTypes'

const MIN_MOVE_NM     = 0.3
const MIN_INTERVAL_MS = 15_000
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
  const inFlightRef  = useRef(false)

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
    fetchWithRetry(`/api/elevation/eudem25m?${params.toString()}`)
      .then(r => r.json())
      .then((data: { results?: { elevation: number | null }[]; status?: string }) => {
        if (data.status !== 'OK' || !data.results?.[0]) return
        const m = data.results[0].elevation
        if (m != null) setSample({ elevFt: Math.round(m * 3.28084), lat: position.lat, lng: position.lng, at: Date.now() })
      })
      .catch(async () => {
        // API unreachable: fall back to the DEM, else terrain stays unknown.
        const dem = getRemoteDem()
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
