/**
 * Lazy cache of the complete se-airspace.geojson feature geometries.
 *
 * MapLibre's queryRenderedFeatures (web) / press-event features (native)
 * return tile-clipped polygons when zoomed in — the geometry only covers
 * the visible viewport/tile area. For an airspace popup's polygon-shape
 * thumbnail we need the full, untruncated polygon.
 *
 * This module fetches the GeoJSON once on first use, then looks up
 * features by (name, lower_ft, upper_ft) to return the complete ring.
 *
 * Shared between web and native. Pass the platform's own airspace GeoJSON
 * URL (web: '/tiles/se-airspace.geojson', native: TILE_URLS.airspace).
 */

import type { Polygon, MultiPolygon, Feature } from 'geojson'

type Key = string   // `${name}|${lower_ft}|${upper_ft}`

let _cache: Map<Key, number[][]> | null = null
let _fetchPromise: Promise<void> | null = null

function makeKey(props: Record<string, unknown>): Key {
  return `${props.name ?? ''}|${props.lower_ft ?? ''}|${props.upper_ft ?? ''}`
}

function exteriorRing(geom: Polygon | MultiPolygon): number[][] {
  if (geom.type === 'Polygon') return geom.coordinates[0]
  // MultiPolygon: return the ring of the largest polygon by vertex count
  return geom.coordinates.reduce((best, poly) =>
    poly[0].length > best.length ? poly[0] : best,
    geom.coordinates[0][0],
  )
}

async function loadCache(tileUrl: string): Promise<void> {
  try {
    const res  = await fetch(tileUrl)
    const data = await res.json() as { features: Feature[] }
    _cache = new Map()
    for (const f of data.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>
      const geom = f.geometry as Polygon | MultiPolygon | null
      if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue
      _cache.set(makeKey(p), exteriorRing(geom))
    }
  } catch {
    _cache = new Map()   // empty on error — fallback to clipped geometry
  }
}

/**
 * Return the complete exterior ring for an airspace feature by its
 * properties, falling back to `clippedCoords` if not found.
 */
export async function getFullRing(
  props: { name?: string; lower_ft?: number; upper_ft?: number },
  tileUrl: string,
  clippedCoords?: number[][],
): Promise<number[][] | undefined> {
  if (!_fetchPromise) _fetchPromise = loadCache(tileUrl)
  await _fetchPromise

  const key   = makeKey(props as Record<string, unknown>)
  const found = _cache?.get(key)
  return found ?? clippedCoords
}
