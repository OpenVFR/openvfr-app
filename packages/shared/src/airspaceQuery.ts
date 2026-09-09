/**
 * Independent airspace lookup at a lat/lng point — always queries the FULL
 * se-airspace.geojson dataset, bypassing MapLibre's rendered-feature query.
 *
 * Why this exists: the altitude-ceiling slider and per-class layer toggles
 * (LayerPanel) only control what's *visually drawn* on the map — they set
 * `filter`/`layout.visibility` on the airspace layers. `queryRenderedFeatures`
 * (web) and press-event features (native) only return features that are
 * actually rendered, so a filtered-out or toggled-off airspace class would
 * silently vanish from tap results too. Airspace awareness (both the
 * proximity warnings and the tap-to-inspect popup) must stay complete
 * regardless of what's currently shown, so both read from this instead.
 *
 * Shared between web and native. Pass the platform's own airspace GeoJSON
 * URL (web: '/tiles/se-airspace.geojson', native: TILE_URLS.airspace).
 */

import type { Polygon, MultiPolygon, Feature, FeatureCollection } from 'geojson'
import { pointInPolygon } from './airspaceGeometry'

export interface AirspaceQueryFeature {
  class: string
  type: string
  name: string
  upper: string
  lower: string
  upper_ft: number
  lower_ft: number
  remarks?: string
  frequencies?: { freq_mhz: number; callsign: string; service: string }[]
  coords?: number[][]   // full exterior ring — no tile-clipping involved
}

let _cache: Feature[] | null = null
let _cacheUrl: string | null = null
let _fetchPromise: Promise<void> | null = null

async function load(tileUrl: string): Promise<void> {
  try {
    const res  = await fetch(tileUrl)
    const data = await res.json() as FeatureCollection
    _cache    = data.features
    _cacheUrl = tileUrl
  } catch {
    _cache    = []
    _cacheUrl = tileUrl
  }
}

function parseFrequencies(v: unknown): { freq_mhz: number; callsign: string; service: string }[] | undefined {
  if (!v) return undefined
  return typeof v === 'string' ? JSON.parse(v) : v as { freq_mhz: number; callsign: string; service: string }[]
}

/** All airspace polygons (full, untruncated geometry) containing [lng, lat]. */
export async function queryAirspaceAtPoint(
  lng: number,
  lat: number,
  tileUrl: string,
): Promise<AirspaceQueryFeature[]> {
  if (!_fetchPromise || _cacheUrl !== tileUrl) _fetchPromise = load(tileUrl)
  await _fetchPromise

  const out: AirspaceQueryFeature[] = []
  for (const f of _cache ?? []) {
    const geom = f.geometry as (Polygon | MultiPolygon | null)
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue
    if (!pointInPolygon(lat, lng, geom)) continue

    const p    = (f.properties ?? {}) as Record<string, unknown>
    const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0]
    out.push({
      class:       String(p.class    ?? ''),
      type:        String(p.type     ?? ''),
      name:        String(p.name     ?? ''),
      upper:       String(p.upper    ?? ''),
      lower:       String(p.lower    ?? ''),
      upper_ft:    Number(p.upper_ft ?? 0),
      lower_ft:    Number(p.lower_ft ?? 0),
      remarks:     p.remarks ? String(p.remarks) : undefined,
      frequencies: parseFrequencies(p.frequencies),
      coords:      ring,
    })
  }
  return out.sort((a, b) => a.lower_ft - b.lower_ft)
}
