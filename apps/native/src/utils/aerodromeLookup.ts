/**
 * aerodromeLookup — small ICAO -> {name,lng,lat} index used by PlanScreen's
 * Alternate destination field. Loaded once and cached in memory; mirrors the
 * web project's `getIdentifierLookup()` in RoutePlan.tsx but scoped to
 * aerodromes only (that's all the Alternate field needs).
 */

import { createTileDerived } from './tileDerived'

export type AerodromeLookupEntry = { name: string; lng: number; lat: number }

// Derived per versioned URL (./tileDerived): a new file version or another country loads again; a late result of an
// older URL is never returned for the current one.
const loadLookup = createTileDerived('aerodromes', (fc) => {
  const map = new Map<string, AerodromeLookupEntry>()
  for (const f of fc.features) {
    if (f.geometry.type !== 'Point') continue
    const p = (f.properties ?? {}) as Record<string, unknown>
    const icao = String(p.icao ?? '').toUpperCase()
    if (!icao) continue
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
    map.set(icao, { name: String(p.name ?? icao), lng, lat })
  }
  return map
})

export function getAerodromeLookup(): Promise<Map<string, AerodromeLookupEntry>> {
  return loadLookup()
}
