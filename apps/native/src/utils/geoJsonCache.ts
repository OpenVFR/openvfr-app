/**
 * loadGeoJsonOnce: shared load-once cache for the GeoJSON data files
 * (airspace, obstacles, landmarks, ...), keyed by URL.
 */

import { onTileManifestChanged, versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'
import { TILE_BASE, tileUrlReady, type TileKey } from '../config'

// ---------------------------------------------------------------------------
// Module-level GeoJSON cache — fetch + JSON.parse each file exactly once per
// app lifetime, not once per component mount (VerticalProfile, the log list's
// events, ...).
//
// Without this, every fresh mount (ruler mode turned on, route planned,
// look-ahead engaged after a route is cleared, etc. — each is a distinct
// branch in MapScreen's render ternary, so switching between them unmounts
// and remounts this component) re-fetched and re-JSON.parsed all the files
// (airspace, obstacles, landmarks) from scratch. `JSON.parse` of a
// several-hundred-KB-to-multi-MB payload runs synchronously on the JS
// thread — with 4 of them in flight together, this stalled the JS thread
// for several seconds, during which every touchable on screen (map controls,
// sheets, etc.) silently ate taps while MapLibre's own native pan/zoom kept
// working fine (it doesn't depend on the JS thread), making the app look
// frozen right after e.g. placing the ruler's second point. Mirrors the
// same load-once module cache pattern already used by
// usePositionAlerts.ts (combined airspace/obstruction/airfield/notification hook).
// ---------------------------------------------------------------------------
const _geoJsonCache = new Map<string, Promise<GeoJSON.FeatureCollection>>()
// Keyed by URL, so a new data version (new ?v=) or another country loads fresh by itself. On a manifest
// change only the entries whose URL is no longer the current one for their file are dropped (an older
// version, or an unversioned fallback URL from a start without the manifest); unchanged files stay parsed.
/** A tile-host URL that is not the current one for its file (an older version, or an unversioned fallback). */
export function isOutdatedTileUrl(url: string): boolean {
  if (!url.startsWith(`${TILE_BASE}/`)) return false
  const fileName = url.slice(TILE_BASE.length + 1).split('?')[0]
  return versionedTileUrl(TILE_BASE, fileName) !== url
}
onTileManifestChanged(() => {
  for (const url of [..._geoJsonCache.keys()]) if (isOutdatedTileUrl(url)) _geoJsonCache.delete(url)
})

/** One of the active country's data files by its versioned URL (waits for the manifest, see tileUrlReady). */
export async function loadTileGeoJson(key: TileKey): Promise<GeoJSON.FeatureCollection> {
  return loadGeoJsonOnce(await tileUrlReady(key))
}

export function loadGeoJsonOnce(url: string): Promise<GeoJSON.FeatureCollection> {
  let p = _geoJsonCache.get(url)
  if (!p) {
    p = fetchWithRetry(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
      return r.json()
    })
    p.catch(() => { if (_geoJsonCache.get(url) === p) _geoJsonCache.delete(url) })   // allow retry on next mount if it failed
    _geoJsonCache.set(url, p)
  }
  return p
}
