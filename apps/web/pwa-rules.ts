/**
 * Service-worker routing rules shared by vite.config.ts and their test.
 *
 * Tile data files (geojson) come from the tile host however it is reached: a `/tiles/` path segment anywhere (dev; any build
 * that proxies the host; a self-hosted VITE_TILES_BASE_URL such as https://cdn.example.org/aviation/tiles) or a tile host such as https://tiles.openvfr.org/<file> (production and staging, no `/tiles/` segment).
 * The runtime cache must match both: a rule written for `/tiles/` alone silently cached nothing in production.
 *
 * vite.config.ts repeats this logic INLINE in its `urlPattern`: workbox serializes that function into sw.js as text, where no import
 * or helper exists. This copy is what the tests run; pwaRules.test.ts also checks the two stay identical.
 */
export function isTileGeojson(url: URL): boolean {
  return url.pathname.endsWith('.geojson') && (url.pathname.includes('/tiles/') || url.hostname.startsWith('tiles.'))
}

/**
 * The tile host's manifest.json (content hashes that version every tile URL). NetworkFirst in the service worker: always the
 * network copy when online, the last one offline. Without it an offline start has no manifest, so the apps would ask for the
 * unversioned URLs, which the geojson cache above does not hold (it only ever stores the versioned ones).
 */
export function isTileManifest(url: URL): boolean {
  return url.pathname.endsWith('/manifest.json') && (url.pathname.includes('/tiles/') || url.hostname.startsWith('tiles.'))
}
