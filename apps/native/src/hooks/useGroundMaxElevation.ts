/**
 * useGroundMaxElevation: the highest ground (ft AMSL) within AREA_RADIUS_M
 * of the position, for takeoff detection (@open-vfr/shared/autoFlyDetect
 * needs the aircraft clearly above it before it counts a fast fix as flight).
 *
 * Only runs while `active` (not flying, moving): the detector needs it for
 * the start only. Source: the downloaded DEM, else one multi-point elevation
 * API request (@open-vfr/shared/pointElevation areaMaxElevationFt).
 *
 * A sample counts for STALE_DIST_NM around where it was taken (less than the
 * sampled radius) and STALE_AGE_MS; after that the result is null and the
 * detector falls back to its climb rule.
 */

import { useEffect, useRef, useState } from 'react'
import { areaMaxElevationFt } from '@open-vfr/shared/pointElevation'
import { API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { authHeaders } from '../utils/authClient'
import type { GpsPosition } from '../utils/gpsTypes'

const AREA_RADIUS_M   = 500
/** Refetch after this much movement (well inside the sampled radius) ... */
const MIN_MOVE_NM     = 0.15
/** ... or this long. */
const MIN_INTERVAL_MS = 30_000
const STALE_DIST_NM   = 0.25
const STALE_AGE_MS    = 2 * 60_000

type Sample = { maxFt: number; lat: number; lng: number; at: number }

function quickDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

export function useGroundMaxElevation(position: GpsPosition | null, active: boolean): number | null {
  const [sample, setSample] = useState<Sample | null>(null)
  const lastFetchRef = useRef<{ lat: number; lng: number; at: number } | null>(null)
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!position || !active || inFlightRef.current) return
    const last = lastFetchRef.current
    const now = Date.now()
    if (last && quickDistNm(last.lat, last.lng, position.lat, position.lng) < MIN_MOVE_NM && now - last.at < MIN_INTERVAL_MS) return
    inFlightRef.current = true
    lastFetchRef.current = { lat: position.lat, lng: position.lng, at: now }
    const { lat, lng } = position
    areaMaxElevationFt(lat, lng, AREA_RADIUS_M, { dem: getOfflineDem(), baseUrl: API_BASE, headers: authHeaders })
      .then((ft) => { if (ft != null) setSample({ maxFt: ft, lat, lng, at: Date.now() }) })
      .finally(() => { inFlightRef.current = false })
  }, [position, active])

  if (!active || !sample || !position) return null
  if (Date.now() - sample.at > STALE_AGE_MS) return null
  if (quickDistNm(sample.lat, sample.lng, position.lat, position.lng) > STALE_DIST_NM) return null
  return sample.maxFt
}
