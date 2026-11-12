/**
 * Service-worker routing rules shared by vite.config.ts and their test.
 *
 * Tile data files (geojson) come from the tile host however it is reached: the same-origin `/tiles/` path (dev, and any build
 * that proxies the host) or a tile host such as https://tiles.openvfr.org/<file> (production and staging, no `/tiles/` segment).
 * The runtime cache must match both: a rule written for `/tiles/` alone silently cached nothing in production.
 *
 * vite.config.ts repeats this logic INLINE in its `urlPattern`: workbox serializes that function into sw.js as text, where no import
 * or helper exists. This copy is what the tests run; pwaRules.test.ts also checks the two stay identical.
 */
export function isTileGeojson(url: URL): boolean {
  return url.pathname.endsWith('.geojson') && (url.pathname.startsWith('/tiles/') || url.hostname.startsWith('tiles.'))
}
