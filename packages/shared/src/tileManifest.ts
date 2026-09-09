// packages/shared/src/tileManifest.ts
//
// Cache-busting for object-storage-hosted static tile files (bulk aviation
// data: basemap, airspace, aerodromes, navaids, waypoints, runways,
// obstacles, landmarks, landuse). Shared between web and native since BOTH
// fetch through the same CDN-fronted URL -- native's offline-download feature
// (native/src/utils/offlineCache.ts) has the identical staleness exposure as
// a browser tab, even though it stores the result in its own local file
// cache afterward, not the browser's HTTP cache.
//
// Why this exists: a static tile file's filename never changes
// (se-obstacles.geojson is always se-obstacles.geojson), but its CONTENT
// does, on each dataset's refresh cadence. A CDN edge cache keyed purely on
// URL has no way to know the content changed -- it will happily keep
// serving stale bytes for as long as its TTL says to, unless something
// changes the cache key on every real content update. That's what this
// module does: appends a `?v=<content-hash-prefix>` query string derived
// from manifest.json's already-computed sha256 (see scripts/write_manifest.py)
// to every tile URL. A new upload always produces a new hash, therefore a
// new query string, therefore a guaranteed-fresh fetch on the very next
// request after a real content change -- while the OLD query-string-keyed
// cache entry is simply never referenced again (not invalidated, just
// orphaned, which is fine -- it ages out on its own).
//
// This is the same pattern bundlers like Vite use for JS/CSS
// (index-<hash>.js) -- combined with a long, `immutable` Cache-Control on
// the storage objects themselves (set at upload time), this makes CDN/browser
// caching fully safe with no staleness risk at all. See docs/self-hosting.md
// for the general design.
//
// manifest.json ITSELF must never be cached this way (it's the root of
// trust for every other file's version) -- it's uploaded with a short/
// no-cache Cache-Control instead, so this module's own fetch of it always
// gets a reasonably current view.

export interface TileManifestFileEntry {
  sha256: string
  bytes: number
}

export interface TileManifestDataset {
  loaded_at?: string
  row_count?: number
  airac_cycle?: string
}

export interface TileManifest {
  generated_at: string
  // write_manifest.py always writes both keys, even as an empty object when
  // that side hasn't run yet -- so these are structurally guaranteed once a
  // manifest exists at all; only the outer TileManifest itself is
  // nullable (fetch failed / not generated yet), not these fields.
  countries: Record<string, Record<string, TileManifestDataset>>
  files: Record<string, TileManifestFileEntry>
}

let cachedManifest: TileManifest | null = null
let loadPromise: Promise<void> | null = null

/**
 * Fetches manifest.json from `${tilesBaseUrl}/manifest.json` and caches it
 * in memory for the app session. Safe to call multiple times (returns the
 * same in-flight/resolved promise) -- call once at app startup, fire-and-
 * forget (no need to await before rendering). versionedTileUrl() degrades
 * gracefully to an unversioned URL for any call made before this resolves,
 * or if the fetch fails entirely (offline first launch, dev environment
 * without a generated manifest yet, etc.) -- matches this codebase's
 * existing "gracefully handle 404 / missing manifest" philosophy
 * (see the original useDataManifest.ts hook this module's fetch replaces).
 */
export function loadTileManifest(tilesBaseUrl: string): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = fetch(`${tilesBaseUrl}/manifest.json`, { cache: 'no-store' })
    .then(res => (res.ok ? (res.json() as Promise<TileManifest>) : null))
    .then(data => { cachedManifest = data })
    .catch(() => { cachedManifest = null })
  return loadPromise
}

/** Force a re-fetch (e.g. a user-triggered "check for updates" action). */
export function refreshTileManifest(tilesBaseUrl: string): Promise<void> {
  loadPromise = null
  return loadTileManifest(tilesBaseUrl)
}

/** Currently cached manifest, or null if not loaded yet / fetch failed. */
export function getCachedTileManifest(): TileManifest | null {
  return cachedManifest
}

/**
 * Builds a cache-busted URL for a static tile file. Returns
 * `${tilesBaseUrl}/${filename}?v=<sha256 prefix>` if the manifest has an
 * entry for filename, else the plain unversioned URL as a safe fallback.
 */
export function versionedTileUrl(tilesBaseUrl: string, filename: string): string {
  const entry = cachedManifest?.files?.[filename]
  const base = `${tilesBaseUrl}/${filename}`
  return entry ? `${base}?v=${entry.sha256.slice(0, 12)}` : base
}
