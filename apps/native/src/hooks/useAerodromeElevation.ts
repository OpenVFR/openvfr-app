/**
 * useAerodromeElevation — resolves an aerodrome ICAO to its elevation (ft
 * AMSL), for self-calibrating QNH from a barometric source's raw pressure
 * reading while parked at a known field (see baroAltitude.ts's
 * qnhFromStationPressure). Same per-hook module-cache pattern as
 * useHomeAirfield.ts / useNearbyFrequencies.ts / useNearestQnh.ts \u2014
 * each hook keeps its own small cache of just the fields it needs rather
 * than sharing one broad aerodromes store.
 */

import { useEffect, useState } from 'react'
import { getTileUrls } from '../config'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'

let _cache: Array<{ icao: string; elevationFt: number }> | null = null
let _loading = false
// Per-country data: a new active country starts a fresh load.
onActiveCountriesChange(() => { _cache = null; _loading = false })
const _listeners: Array<(d: typeof _cache) => void> = []

function loadOnce(cb: (d: typeof _cache) => void) {
  if (_cache) { cb(_cache); return }
  _listeners.push(cb)
  if (_loading) return
  _loading = true
  fetch(getTileUrls().aerodromes)
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      _cache = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p = f.properties as Record<string, unknown>
        const icao = String(p.icao ?? '').trim()
        const elevationFt = Number(p.elevation_ft)
        if (!icao || !Number.isFinite(elevationFt)) continue
        _cache.push({ icao, elevationFt })
      }
      _listeners.forEach(l => l(_cache))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

export function useAerodromeElevation(icao: string): number | null {
  const [elevationFt, setElevationFt] = useState<number | null>(null)

  useEffect(() => {
    if (!icao) { setElevationFt(null); return }
    loadOnce((data) => {
      const match = data?.find(a => a.icao.toUpperCase() === icao.toUpperCase())
      setElevationFt(match ? match.elevationFt : null)
    })
  }, [icao])

  return elevationFt
}
