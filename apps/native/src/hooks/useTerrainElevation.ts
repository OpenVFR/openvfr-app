/**
 * useTerrainElevation — live single-point ground elevation lookup for the
 * current GPS position, used to compute Height AGL (T.ALT AGL) in GaugesBar.
 *
 * Throttled: only re-fetches when the position has moved more than
 * MIN_MOVE_NM or MIN_INTERVAL_MS has elapsed, to avoid spamming OpenTopoData
 * on every GPS tick (1 Hz).
 */

import { useEffect, useRef, useState } from 'react'
import { TILE_BASE } from '../config'
import type { GpsPosition } from '../utils/gpsTypes'
import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'

const MIN_MOVE_NM     = 0.3
const MIN_INTERVAL_MS = 15_000

function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

export function useTerrainElevation(position: GpsPosition | null): number | null {
  const [elevFt, setElevFt] = useState<number | null>(null)
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
    fetchWithRetry(`${TILE_BASE}/api/elevation/eudem25m?${params.toString()}`)
      .then(r => r.json())
      .then((data: { results?: { elevation: number | null }[]; status?: string }) => {
        if (data.status !== 'OK' || !data.results?.[0]) return
        const m = data.results[0].elevation
        if (m != null) setElevFt(Math.round(m * 3.28084))
      })
      .catch(() => { /* non-fatal — AGL just stays unavailable */ })
      .finally(() => { inFlightRef.current = false })
  }, [position])

  return elevFt
}
