/**
 * useAerodromeElevation — resolves an aerodrome ICAO to its elevation (ft
 * AMSL), for self-calibrating QNH from a barometric source's raw pressure
 * reading while parked at a known field (see baroAltitude.ts's
 * qnhFromStationPressure). Same per-hook module-cache pattern as
 * useHomeAirfield.ts / useNearbyFrequencies.ts / useNearestQnh.ts \u2014
 * each hook keeps its own small cache of just the fields it needs rather
 * than sharing one broad aerodromes store.
 */

import { useMemo } from 'react'
import { createTileDerived, useTileDerived } from '../utils/tileDerived'

// Derived per versioned URL (utils/tileDerived): a new file version or another country loads again.
const loadAerodromes = createTileDerived('aerodromes', (fc): Array<{ icao: string; elevationFt: number }> => {
  const out: Array<{ icao: string; elevationFt: number }> = []
  for (const f of fc.features) {
    if (f.geometry.type !== 'Point') continue
    const p = f.properties as Record<string, unknown>
    const icao = String(p.icao ?? '').trim()
    const elevationFt = Number(p.elevation_ft)
    if (!icao || !Number.isFinite(elevationFt)) continue
    out.push({ icao, elevationFt })
  }
  return out
})

export function useAerodromeElevation(icao: string): number | null {
  const data = useTileDerived(loadAerodromes, !!icao)
  return useMemo(() => {
    if (!icao || !data) return null
    const match = data.find(a => a.icao.toUpperCase() === icao.toUpperCase())
    return match ? match.elevationFt : null
  }, [data, icao])
}
