/**
 * useGroundMaxElevation: the highest ground (ft AMSL) within AREA_RADIUS_M
 * of the position, for takeoff detection (@open-vfr/shared/autoFlyDetect
 * needs the aircraft clearly above it before it counts a fast fix as flight).
 * Used by useAutoFlyDetect, which decides when it is `active`.
 *
 * Source: the downloaded DEM, else one multi-point elevation API request
 * (@open-vfr/shared/pointElevation areaMaxElevationFt). The API is a shared,
 * small free budget, so requests are kept rare:
 *  - only while `active`;
 *  - only when there is no usable sample (none, older than STALE_AGE_MS, or
 *    taken more than STALE_DIST_NM away -- less than the sampled radius);
 *  - at most MAX_FETCHES_PER_EPISODE per fast episode (reset by
 *    `resetEpisode`, i.e. once the device has slowed right down), and not
 *    more often than MIN_RETRY_MS after a failed one.
 * A takeoff needs one, maybe two; a long drive on hilly roads at most three.
 */

import { useEffect, useRef, useState } from 'react'
import { areaMaxElevationFt } from '@open-vfr/shared/pointElevation'
import { quickDistNm } from '@open-vfr/shared/quickDist'
import { API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { authHeaders } from '../utils/authClient'
import type { GpsPosition } from '../utils/gpsTypes'

const AREA_RADIUS_M           = 500
const STALE_DIST_NM           = 0.25
const STALE_AGE_MS            = 2 * 60_000
const MAX_FETCHES_PER_EPISODE = 3
const MIN_RETRY_MS            = 15_000

type Sample = { maxFt: number; lat: number; lng: number; at: number }

function usable(sample: Sample | null, position: GpsPosition, now: number): sample is Sample {
  return sample != null && now - sample.at <= STALE_AGE_MS
    && quickDistNm(sample.lat, sample.lng, position.lat, position.lng) <= STALE_DIST_NM
}

export function useGroundMaxElevation(position: GpsPosition | null, active: boolean, resetEpisode: boolean): number | null {
  const [sample, setSample] = useState<Sample | null>(null)
  const fetchesRef = useRef(0)
  const lastAttemptRef = useRef(0)
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (resetEpisode) fetchesRef.current = 0
    if (!position || !active || inFlightRef.current) return
    const now = Date.now()
    if (usable(sample, position, now)) return
    if (fetchesRef.current >= MAX_FETCHES_PER_EPISODE || now - lastAttemptRef.current < MIN_RETRY_MS) return
    fetchesRef.current++
    lastAttemptRef.current = now
    inFlightRef.current = true
    const { lat, lng } = position
    areaMaxElevationFt(lat, lng, AREA_RADIUS_M, { dem: getOfflineDem(), baseUrl: API_BASE, headers: authHeaders })
      .then((ft) => { if (ft != null) setSample({ maxFt: ft, lat, lng, at: Date.now() }) })
      .finally(() => { inFlightRef.current = false })
  }, [position, active, resetEpisode, sample])

  if (!active || !position || !usable(sample, position, Date.now())) return null
  return sample.maxFt
}
