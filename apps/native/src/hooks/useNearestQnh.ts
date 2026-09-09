/**
 * useNearestQnh — auto-derives current QNH via inverse-distance-weighted
 * interpolation across nearby aerodromes' METARs, rather than trusting a
 * single nearest station's reading (see @open-vfr/shared/qnhInterpolation
 * for why: closer stations count more, but every station in range still
 * contributes, smoothing out one station's local pressure noise). This goes
 * one step further than a simple nearest-station lookup.
 *
 * Reuses the existing aerodrome proximity + METAR fetch machinery
 * (useNearbyFrequencies.ts's loadOnce cache pattern, fetchWx/decodeMetar
 * from @open-vfr/shared) rather than duplicating either.
 *
 * Throttled the same way useTerrainElevation is — no need to re-fetch on
 * every 1 Hz GPS tick, only when the aircraft has moved meaningfully or
 * enough time has passed for METARs to plausibly have updated.
 */

import { useEffect, useRef, useState } from 'react'
import { fetchWx, decodeMetar } from '@open-vfr/shared/fetchWx'
import { interpolateQnh, type QnhReading } from '@open-vfr/shared/qnhInterpolation'
import { distanceNm } from '../utils/routeCalc'
import { TILE_URLS, API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'
import type { GpsPosition } from '../utils/gpsTypes'

const MIN_MOVE_NM     = 5      // re-evaluate nearby aerodromes after this much movement
const MIN_INTERVAL_MS = 10 * 60_000  // …or after 10 minutes, whichever first (METARs update ~hourly)
const CANDIDATE_COUNT = 6      // fetch METARs for up to N nearest aerodromes concurrently
const MAX_RADIUS_NM   = 150    // stations farther than this contribute negligibly anyway (1/d weighting) — skip the fetch entirely

export type NearestQnhResult = {
  qnhHpa: number | null
  /** Nearest contributing station, for the primary UI label. */
  stationIcao: string | null
  /** All stations that contributed to the interpolated value, nearest-first. */
  stations: string[]
}

interface CachedAerodrome {
  icao: string
  lat:  number
  lng:  number
}

// Module-level cache — shared across all hook instances, same pattern as
// useNearbyFrequencies.ts's loadOnce().
let _cache: CachedAerodrome[] | null = null
let _loading = false
const _listeners: Array<(data: CachedAerodrome[]) => void> = []

function loadOnce(onLoad: (data: CachedAerodrome[]) => void) {
  if (_cache) { onLoad(_cache); return }
  _listeners.push(onLoad)
  if (_loading) return
  _loading = true
  fetch(TILE_URLS.aerodromes)
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: CachedAerodrome[] = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p    = f.properties as Record<string, unknown>
        const icao = String(p.icao ?? '')
        if (!icao) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        arr.push({ icao, lat, lng })
      }
      _cache = arr
      _listeners.forEach(cb => cb(arr))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

/** Convert a decoded METAR QNH token (Q1013 or A2992) to hPa. */
function qnhTokenToHpa(tok: string): number | null {
  if (tok.startsWith('Q')) {
    const hpa = Number(tok.slice(1))
    return Number.isFinite(hpa) ? hpa : null
  }
  if (tok.startsWith('A')) {
    // Altimeter setting in inches Hg * 100 (e.g. A2992 = 29.92 inHg)
    const inHg = Number(tok.slice(1)) / 100
    return Number.isFinite(inHg) ? inHg * 33.8639 : null
  }
  return null
}

const EMPTY_RESULT: NearestQnhResult = { qnhHpa: null, stationIcao: null, stations: [] }

export function useNearestQnh(position: GpsPosition | null, enabled: boolean): NearestQnhResult {
  const [aerodromes, setAerodromes] = useState<CachedAerodrome[]>([])
  const [result, setResult] = useState<NearestQnhResult>(EMPTY_RESULT)
  const lastFetchRef = useRef<{ lat: number; lng: number; at: number } | null>(null)
  const inFlightRef  = useRef(false)

  useEffect(() => {
    if (!enabled) return
    loadOnce(setAerodromes)
  }, [enabled])

  useEffect(() => {
    if (!enabled || !position || aerodromes.length === 0) return

    const last = lastFetchRef.current
    const now  = Date.now()
    if (last) {
      const movedNm = distanceNm({ lat: last.lat, lng: last.lng }, { lat: position.lat, lng: position.lng })
      if (movedNm < MIN_MOVE_NM && (now - last.at) < MIN_INTERVAL_MS) return
    }
    if (inFlightRef.current) return
    inFlightRef.current = true
    lastFetchRef.current = { lat: position.lat, lng: position.lng, at: now }

    const pos = { lat: position.lat, lng: position.lng }
    const nearest = [...aerodromes]
      .map(a => ({ ...a, distNm: distanceNm(pos, { lat: a.lat, lng: a.lng }) }))
      .filter(a => a.distNm <= MAX_RADIUS_NM)
      .sort((a, b) => a.distNm - b.distNm)
      .slice(0, CANDIDATE_COUNT)

    ;(async () => {
      const headers = await authHeaders()
      const settled = await Promise.allSettled(
        nearest.map(async (candidate): Promise<QnhReading | null> => {
          const wx = await fetchWx(candidate.icao, API_BASE, undefined, headers)
          if (!wx.metar) return null
          const decoded = decodeMetar(wx.metar)
          if (!decoded.qnh) return null
          const hpa = qnhTokenToHpa(decoded.qnh)
          if (hpa == null) return null
          return { icao: candidate.icao, distNm: candidate.distNm, qnhHpa: hpa }
        }),
      )

      const readings: QnhReading[] = []
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) readings.push(s.value)
      }

      inFlightRef.current = false

      const interpolated = interpolateQnh(readings)
      if (!interpolated) return  // no usable readings — leave previous result in place (stale-but-recent beats flapping to null)

      setResult({
        qnhHpa:      interpolated.qnhHpa,
        stationIcao: interpolated.stations[0] ?? null,
        stations:    interpolated.stations,
      })
    })()
  }, [position, aerodromes, enabled])

  return result
}
