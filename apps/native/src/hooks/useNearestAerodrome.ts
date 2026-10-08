/**
 * useNearestAerodrome — resolves the closest aerodrome to a live GPS
 * position, with its ICAO, distance, and field elevation. Used to
 * auto-suggest a QNH self-calibration target (see baroAltitude.ts's
 * qnhFromStationPressure + SettingsScreen's "Calibrate QNH" row) \u2014 the
 * pilot is very likely parked at whichever aerodrome they're currently
 * closest to, no need to make them type an ICAO by hand in that case.
 *
 * Same per-hook module-cache pattern as useHomeAirfield.ts /
 * useAerodromeElevation.ts / useNearestQnh.ts.
 */

import { useEffect, useState, useRef } from 'react'
import { getTileUrls } from '../config'
import { distanceNm } from '../utils/routeCalc'
import type { GpsPosition } from '../utils/gpsTypes'

type CachedAerodrome = { icao: string; lat: number; lng: number; elevationFt: number }

let _cache: CachedAerodrome[] | null = null
let _loading = false
const _listeners: Array<(d: CachedAerodrome[]) => void> = []

function loadOnce(cb: (d: CachedAerodrome[]) => void) {
  if (_cache) { cb(_cache); return }
  _listeners.push(cb)
  if (_loading) return
  _loading = true
  fetch(getTileUrls().aerodromes)
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: CachedAerodrome[] = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p = f.properties as Record<string, unknown>
        const icao = String(p.icao ?? '').trim()
        // A missing elevation must not become 0 (Number(null) === 0): the QNH
        // self-calibration would then treat the field as sea level.
        if (p.elevation_ft == null || p.elevation_ft === '') continue
        const elevationFt = Number(p.elevation_ft)
        if (!icao || !Number.isFinite(elevationFt)) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        arr.push({ icao, lat, lng, elevationFt })
      }
      _cache = arr
      _listeners.forEach(l => l(arr))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

export type NearestAerodromeResult = {
  icao:        string
  elevationFt: number
  distanceNm:  number
} | null

export function useNearestAerodrome(position: GpsPosition | null): NearestAerodromeResult {
  const [aerodromes, setAerodromes] = useState<CachedAerodrome[]>([])
  const [result, setResult] = useState<NearestAerodromeResult>(null)
  const resultRef = useRef<NearestAerodromeResult>(null)

  useEffect(() => { loadOnce(setAerodromes) }, [])

  useEffect(() => {
    if (!position || aerodromes.length === 0) {
      if (resultRef.current !== null) { resultRef.current = null; setResult(null) }
      return
    }
    let best: CachedAerodrome | null = null
    let bestDist = Infinity
    for (const a of aerodromes) {
      const d = distanceNm({ lat: position.lat, lng: position.lng }, { lat: a.lat, lng: a.lng })
      if (d < bestDist) { bestDist = d; best = a }
    }
    // `position` is a new object every GPS/sim tick. Calling setResult from this
    // effect each time re-rendered the whole screen per tick (even a no-op updater
    // counts as an update scheduled during effects), so compare against a ref and
    // only set state when the visible result actually changes.
    const dist = Math.round(bestDist * 10) / 10
    const next = best ? { icao: best.icao, elevationFt: best.elevationFt, distanceNm: dist } : null
    const prev = resultRef.current
    if (prev === next || (prev && next && prev.icao === next.icao && prev.distanceNm === next.distanceNm)) return
    resultRef.current = next
    setResult(next)
  }, [position, aerodromes])

  return result
}
