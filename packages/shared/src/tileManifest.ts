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
//
// FETCH ONLY VERSIONED URLS: code that fetches a tile file must build its
// URL with `versionedTileUrlReady()` (or a helper built on it, such as
// countryData's loadCountryGeojson / countryFileUrlReady), never with the
// synchronous `versionedTileUrl()` at a moment the manifest may not have
// loaded yet. The synchronous form returns the bare, unversioned URL until
// then, and the apps used to fetch most GeoJSON files that way right after
// start: a cache in between that keeps unversioned responses (a CDN rule,
// the browser's HTTP cache under a long `immutable` lifetime, a service
// worker) then served data weeks old, for the whole session. The async
// helper waits for the manifest for a bounded time and only then falls back
// to the unversioned URL (manifest missing, offline, slow). Map styles that
// are built once wait the same way (`waitForTileManifest`).
//
// When such a fallback URL was handed out and the manifest arrives later,
// the change listeners fire (as for a real data update), so caches keyed by
// URL can drop what they loaded unversioned (see `onTileManifestChanged`).

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
/** The load promise that has finished (successfully or not), or whose bounded wait has run out once. */
let settledLoad: Promise<void> | null = null
let gaveUpOn: Promise<void> | null = null
/** A waitForTileManifest() caller went on without a manifest, i.e. with unversioned URLs. */
let unversionedIssued = false
type ManifestChangeListener = () => void
const changeListeners = new Set<ManifestChangeListener>()

function notifyListeners(): void {
  changeListeners.forEach((listener) => {
    try { listener() } catch (err) { console.warn('[tileManifest] change listener failed:', err) }
  })
}

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
  const p: Promise<void> = fetch(`${tilesBaseUrl}/manifest.json`, { cache: 'no-store' })
    .then(res => (res.ok ? (res.json() as Promise<TileManifest>) : null))
    .catch(() => null)
    .then((data) => {
      // A failed refetch keeps the manifest already known: its versioned URLs
      // still name consistent content, while dropping it would send every
      // later fetch to the unversioned URL.
      if (!data || typeof data !== 'object' || !data.files) return
      const first = cachedManifest === null
      cachedManifest = data
      // Unversioned fallback URLs were handed out before this first manifest:
      // tell URL-keyed caches to reload (same signal as a data update).
      if (first && unversionedIssued) { unversionedIssued = false; notifyListeners() }
    })
    .finally(() => { settledLoad = p })
  loadPromise = p
  return p
}

/** Force a re-fetch (e.g. a user-triggered "check for updates" action). */
export function refreshTileManifest(tilesBaseUrl: string): Promise<void> {
  loadPromise = null
  return loadTileManifest(tilesBaseUrl)
}

/**
 * Waits for the manifest to resolve (reusing loadTileManifest()'s own
 * dedup'd promise) OR a bounded timeout, whichever comes first. Never
 * rejects -- a timeout or fetch failure just means callers proceed with
 * whatever cachedManifest already is (null, or a previous value), exactly
 * matching versionedTileUrl()'s existing graceful degrade-to-unversioned
 * behavior. Never blocks forever even fully offline.
 *
 * WHY THIS EXISTS: `loadTileManifest()` is fire-and-forget by design (see
 * this module's header comment) so it never blocks the app shell/login
 * check from rendering -- correct for most consumers, which re-render
 * naturally and pick up a freshly-resolved manifest on their next render.
 * It is NOT correct for a consumer that builds a URL exactly ONCE into an
 * object that can't be cheaply recomputed later -- which is exactly what
 * `getMapStyle()` does for EVERY tile source (aerodromes, navaids, airspace,
 * hillshade, contours, landuse, basemap, ...): it's called synchronously
 * inside `new maplibregl.Map({ style: getMapStyle() })`, and MapLibre
 * sources generally can't have their URL changed after creation without a
 * full remove/re-add (see MapView.tsx's region-swap pattern, only exercised
 * for actual region changes today). Since React mounts and this effect run
 * essentially immediately while `manifest.json` is a real network round
 * trip, `getMapStyle()` was LOSING this race on every single page load in
 * production -- confirmed live via a real browser's Network tab: every
 * tile fetch (not just hillshade) came back with NO `?v=` query string at
 * all, and Cloudflare's edge cache showed `cf-cache-status: HIT` with
 * `age` in the hundreds of thousands of seconds (multiple DAYS stale) for
 * an unversioned `se-aerodromes.geojson` URL that should have been
 * impossible to ever see -- the entire cache-busting system this module
 * exists for was silently defeated for every file, not just hillshade,
 * this whole time. Callers that build a style/source object once (like
 * MapView.tsx's map-init effect) must await this before doing so.
 */
export function waitForTileManifest(tilesBaseUrl: string, timeoutMs = 3000): Promise<void> {
  const load = loadTileManifest(tilesBaseUrl)
  // No wait when a manifest is already known (also during a background
  // refetch), when this load has already finished, or when an earlier
  // caller already waited out the timeout for it: a missing or hanging
  // manifest costs one bounded wait per load, not one per fetch.
  // Whoever resolves without a manifest goes on with unversioned URLs:
  // remember it, so the first manifest that arrives later notifies listeners.
  const done = () => { if (!cachedManifest) unversionedIssued = true }
  if (cachedManifest || settledLoad === load || gaveUpOn === load) { done(); return Promise.resolve() }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { gaveUpOn = load; done(); resolve() }, timeoutMs)
    void load.then(() => { clearTimeout(timer); done(); resolve() })
  })
}

/**
 * The versioned URL of a tile file, for code about to FETCH it: waits for the
 * manifest first (bounded by `timeoutMs`, see waitForTileManifest), then
 * returns versionedTileUrl(). Falls back to the unversioned URL when the
 * manifest cannot be loaded in time or has no entry for the file (an
 * optional file that is not published: its 404 path stays unversioned).
 * Never rejects.
 */
export async function versionedTileUrlReady(tilesBaseUrl: string, filename: string, timeoutMs = 3000): Promise<string> {
  await waitForTileManifest(tilesBaseUrl, timeoutMs)
  return versionedTileUrl(tilesBaseUrl, filename)
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
 * Also fires once when the FIRST manifest of the session arrives after an
 * unversioned fallback URL was already handed out (manifest slow or failed
 * at start): whatever was loaded from such a URL is not tied to a content
 * version, so listeners treat it like a data update.
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
  if (changed) notifyListeners()
}

// Default: 15 minutes. Tile data updates on a server-side cron schedule,
// not in response to user action -- this
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
  let lastCheck = Date.now()
  const check = () => {
    lastCheck = Date.now()
    const previous = cachedManifest
    void refreshTileManifest(tilesBaseUrl).then(() => notifyIfChanged(previous, cachedManifest))
  }
  const id = setInterval(check, intervalMs)

  // Re-check as soon as a backgrounded tab / installed PWA comes back to the
  // foreground instead of waiting out the rest of the interval: browsers
  // throttle or freeze timers in hidden tabs, so a device woken up at the
  // aircraft after days in a bag would otherwise show old data for up to
  // one full interval. Throttled so rapid tab switching doesn't refetch on
  // every flip. Guarded for non-DOM runtimes (native uses AppState instead).
  const MIN_FOREGROUND_RECHECK_MS = 5 * 60 * 1000
  const doc = (globalThis as { document?: Document }).document
  const onVisible = () => {
    if (doc?.visibilityState === 'visible' && Date.now() - lastCheck >= MIN_FOREGROUND_RECHECK_MS) check()
  }
  doc?.addEventListener('visibilitychange', onVisible)

  return () => {
    clearInterval(id)
    doc?.removeEventListener('visibilitychange', onVisible)
  }
}

/** Currently cached manifest, or null if not loaded yet / fetch failed. */
export function getCachedTileManifest(): TileManifest | null {
  return cachedManifest
}

/**
 * Builds a cache-busted URL for a static tile file. Returns
 * `${tilesBaseUrl}/${filename}?v=<sha256 prefix>` if the manifest has an
 * entry for filename, else the plain unversioned URL as a safe fallback.
 *
 * Synchronous: before the manifest has loaded it returns the unversioned
 * URL. Use versionedTileUrlReady() for anything that fetches.
 */
export function versionedTileUrl(tilesBaseUrl: string, filename: string): string {
  const entry = cachedManifest?.files?.[filename]
  const base = `${tilesBaseUrl}/${filename}`
  return entry ? `${base}?v=${entry.sha256.slice(0, 12)}` : base
}

/** True when `url` carries a manifest version (`?v=` / `&v=`). */
export function isVersionedTileUrl(url: string): boolean {
  return /[?&]v=/.test(url)
}
