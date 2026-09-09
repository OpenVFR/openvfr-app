/**
 * useHomeAirfield — resolves the home airfield ICAO to [lng, lat] coordinates.
 * Uses the same module-level aerodromes cache as useNearbyFrequencies.
 */

import { useState, useEffect } from 'react'
import { TILE_URLS } from '../config'

let _cache: Array<{ icao: string; lat: number; lng: number }> | null = null
let _loading = false
const _listeners: Array<(d: typeof _cache) => void> = []

function loadOnce(cb: (d: typeof _cache) => void) {
  if (_cache) { cb(_cache); return }
  _listeners.push(cb)
  if (_loading) return
  _loading = true
  fetch(TILE_URLS.aerodromes)
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      _cache = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p = f.properties as Record<string, unknown>
        const icao = String(p.icao ?? '').trim()
        if (!icao) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        _cache.push({ icao, lat, lng })
      }
      _listeners.forEach(l => l(_cache))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

export function useHomeAirfield(icao: string): [number, number] | null {
  const [coord, setCoord] = useState<[number, number] | null>(null)

  useEffect(() => {
    if (!icao) { setCoord(null); return }
    loadOnce((data) => {
      const match = data?.find(a => a.icao.toUpperCase() === icao.toUpperCase())
      setCoord(match ? [match.lng, match.lat] : null)
    })
  }, [icao])

  return coord
}
