/**
 * aerodromeLookup — small ICAO -> {name,lng,lat} index used by PlanScreen's
 * Alternate destination field. Loaded once and cached in memory; mirrors the
 * web project's `getIdentifierLookup()` in RoutePlan.tsx but scoped to
 * aerodromes only (that's all the Alternate field needs).
 */

import { getTileUrls } from '../config'

export type AerodromeLookupEntry = { name: string; lng: number; lat: number }

let _cache: Map<string, AerodromeLookupEntry> | null = null
let _inFlight: Promise<Map<string, AerodromeLookupEntry>> | null = null

export function getAerodromeLookup(): Promise<Map<string, AerodromeLookupEntry>> {
  if (_cache) return Promise.resolve(_cache)
  if (_inFlight) return _inFlight

  _inFlight = fetch(getTileUrls().aerodromes)
    .then(r => r.json())
    .then((fc: { features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[] }) => {
      const map = new Map<string, AerodromeLookupEntry>()
      for (const f of fc.features) {
        const icao = String(f.properties.icao ?? '').toUpperCase()
        if (!icao) continue
        map.set(icao, {
          name: String(f.properties.name ?? icao),
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
        })
      }
      _cache = map
      return map
    })
    .finally(() => { _inFlight = null })

  return _inFlight
}
