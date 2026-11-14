/**
 * useHomeAirfield — resolves the home airfield ICAO to [lng, lat] coordinates.
 * Uses the same module-level aerodromes cache as useNearbyFrequencies.
 */

import { useMemo } from 'react'
import { createTileDerived, useTileDerived } from '../utils/tileDerived'

// Derived per versioned URL (utils/tileDerived): a new file version or another country loads again.
const loadAerodromes = createTileDerived('aerodromes', (fc): Array<{ icao: string; lat: number; lng: number }> => {
  const out: Array<{ icao: string; lat: number; lng: number }> = []
  for (const f of fc.features) {
    if (f.geometry.type !== 'Point') continue
    const p = f.properties as Record<string, unknown>
    const icao = String(p.icao ?? '').trim()
    if (!icao) continue
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
    out.push({ icao, lat, lng })
  }
  return out
})

export function useHomeAirfield(icao: string): [number, number] | null {
  const data = useTileDerived(loadAerodromes, !!icao)
  return useMemo<[number, number] | null>(() => {
    if (!icao || !data) return null
    const match = data.find(a => a.icao.toUpperCase() === icao.toUpperCase())
    return match ? [match.lng, match.lat] : null
  }, [data, icao])
}
