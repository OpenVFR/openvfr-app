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
type ManifestChangeListener = () => void
const changeListeners = new Set<ManifestChangeListener>()

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

/**
 * Subscribes to "the manifest actually changed content" events (any file's
 * sha256 differs from what was cached before, not just "a refetch happened" --
 * a refetch that returns byte-identical content, the common case, must NOT
 * fire this). Returns an unsubscribe function.
 *
 * Why this exists: `loadTileManifest()` is fetched ONCE per page session
 * (fire-and-forget at app bootstrap, see main.tsx) and cached in the
 * `cachedManifest` module variable for the rest of that session's lifetime.
 * `versionedTileUrl()`'s whole cache-busting scheme depends on the manifest
 * actually being current -- but nothing previously ever re-fetched it after
 * that first load. A browser tab left open across a real data update (which
 * routinely happens -- this is a long-session flight-planning app, not a
 * page users reload constantly) would keep building `?v=<oldHash>` URLs
 * forever, and since those versioned URLs are served with a one-year
 * `immutable` Cache-Control by design, the tab would NEVER see the new data
 * without an unrelated full reload. Confirmed live during a hillshade fix
 * verification: a real, already-deployed, already-corrected R2 upload still
 * looked completely broken in an already-open tab, and only appeared correct
 * in a fresh/incognito session -- indistinguishable from an actual server-
 * side regression without knowing this mechanism, which is a real production
 * usability problem regardless of that specific bug's data pipeline outcome.
 *
 * This module does not decide WHAT to do about a change (reload immediately,
 * hot-swap sources, prompt the user) -- callers do that (see
 * `TileUpdatePrompt.tsx`'s simple "reload on user tap" choice, the safest
 * option given re-adding already-mounted PMTiles sources mid-session risks
 * partial/inconsistent map state).
 */
export function onTileManifestChanged(listener: ManifestChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyIfChanged(previous: TileManifest | null, next: TileManifest | null): void {
  if (!next) return // fetch failed -- never treat "couldn't reach the server" as a data change
  if (!previous) return // first load this session -- nothing to compare against yet
  const prevFiles = previous.files ?? {}
  const nextFiles = next.files ?? {}
  const changed = Object.keys(nextFiles).some(name => prevFiles[name]?.sha256 !== nextFiles[name]?.sha256)
  if (changed) changeListeners.forEach(listener => listener())
}

// Default: 15 minutes. Tile data updates on a cron schedule (see
// openvfr-infra's docker/crontab), not in response to user action -- this
// only needs to be frequent enough that a long-lived open tab eventually
// notices a real update within a reasonable window, not near-realtime.
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

/**
 * Starts periodic background polling for manifest changes (see
 * `onTileManifestChanged`'s header comment for why this exists). Safe to
 * call once at app bootstrap alongside `loadTileManifest()`; returns a
 * cleanup function, though in practice this is meant to run for the app's
 * entire lifetime (same pattern as `UpdatePrompt.tsx`'s service-worker poll).
 */
export function startTileManifestPolling(
  tilesBaseUrl: string,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): () => void {
  const id = setInterval(() => {
    const previous = cachedManifest
    void refreshTileManifest(tilesBaseUrl).then(() => notifyIfChanged(previous, cachedManifest))
  }, intervalMs)
  return () => clearInterval(id)
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
