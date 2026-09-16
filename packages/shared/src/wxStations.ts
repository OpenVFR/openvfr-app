/**
 * wxStations — minimal {icao,name,lat,lng} aerodrome index, used only to
 * build the candidate list for fetchWxResolved's nearest-station METAR/TAF
 * fallback (see fetchWx.ts). Loaded once per resolved aerodromes.geojson URL
 * and cached — web and native each resolve that URL differently (versioned
 * tile base vs. offline-cache-aware getResolvedTileUrls()), so the cache is
 * keyed by URL rather than assuming a single global source.
 */

export interface StationRecord {
  icao: string
  name: string
  lat:  number
  lng:  number
}

const cache = new Map<string, StationRecord[]>()
const inFlight = new Map<string, Promise<StationRecord[]>>()

export function loadStations(aerodromesUrl: string): Promise<StationRecord[]> {
  const cached = cache.get(aerodromesUrl)
  if (cached) return Promise.resolve(cached)
  const existing = inFlight.get(aerodromesUrl)
  if (existing) return existing

  const promise = fetch(aerodromesUrl)
    .then((r) => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: StationRecord[] = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p = f.properties as Record<string, unknown>
        const icao = String(p['icao'] ?? '')
        if (!icao) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
        arr.push({ icao, name: String(p['name'] ?? ''), lat, lng })
      }
      cache.set(aerodromesUrl, arr)
      inFlight.delete(aerodromesUrl)
      return arr
    })
    .catch((err) => {
      inFlight.delete(aerodromesUrl)
      throw err
    })

  inFlight.set(aerodromesUrl, promise)
  return promise
}
