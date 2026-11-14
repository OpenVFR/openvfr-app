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

// ── Module state, in one place ──────────────────────────────────────────────
const SHA256_RE = /^[0-9a-f]{64}$/
/** How long a manifest fetch may take before it is given up (a hung request must not block refreshes forever). */
const MANIFEST_FETCH_TIMEOUT_MS = 20_000
/** With a stored manifest available, how long the network copy is waited for before the stored one is used. */
const STORED_GRACE_MS = 1000

const state = {
  /** The manifest in use, or null (none fetched or stored yet). */
  manifest: null as TileManifest | null,
  /** `manifest` is the stored copy from an earlier session, not one fetched now. */
  fromStorage: false,
  /** The current load (loadTileManifest), shared by every caller until refreshTileManifest starts a new one. */
  load: null as Promise<void> | null,
  /** One bounded wait per load, shared by every waitForTileManifest caller (one timer, one storage read). */
  wait: null as { load: Promise<void>; p: Promise<void> } | null,
  /** A caller went on without any manifest, i.e. with unversioned URLs. */
  unversionedIssued: false,
  store: null as TileManifestStore | null,
  /** The stored manifest read once per tile host (cleared when a new one is written). */
  storedRead: null as { base: string; p: Promise<TileManifest | null> } | null,
}

/**
 * Why listeners are told: `update` = the manifest names other content than
 * before (new data, or a stored copy replaced by a newer fetched one), so
 * data shown may be outdated; `versioned` = the first manifest of the session
 * arrived after callers already went on with unversioned URLs (no data
 * change: caches keyed by URL just reload with versioned URLs; a "new data"
 * prompt must ignore it).
 */
export type TileManifestChangeReason = 'update' | 'versioned'
type ManifestChangeListener = (reason: TileManifestChangeReason) => void
const changeListeners = new Set<ManifestChangeListener>()

/** A usable manifest from untrusted JSON (network or storage): only entries with a 64-hex sha256 are kept. */
function sanitizeManifest(raw: unknown): TileManifest | null {
  const m = raw as Partial<TileManifest> | null
  if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') return null
  const files: Record<string, TileManifestFileEntry> = {}
  for (const [name, e] of Object.entries(m.files as Record<string, Partial<TileManifestFileEntry>>)) {
    if (typeof e?.sha256 === 'string' && SHA256_RE.test(e.sha256)) files[name] = { sha256: e.sha256, bytes: Number(e.bytes) || 0 }
  }
  return {
    generated_at: String(m.generated_at ?? ''),
    countries: m.countries && typeof m.countries === 'object' ? m.countries : {},
    files,
  }
}

// ── Last manifest on the device (optional, native) ──────────────────────────
// Offline at start, the manifest cannot be fetched, so every URL would be the
// unversioned one, and the map renderer's own cache only holds the versioned
// URLs it fetched before: a restart in flight showed a blank map over areas
// viewed earlier. With a store enabled, the last manifest fetched is kept and
// used when the network copy cannot be had (fetch failed, or not there within
// STORED_GRACE_MS). Its versions name content the device may still have
// cached; it is replaced as soon as a fresh manifest arrives (listeners get
// `update` if it differs).
export interface TileManifestStore {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
}
const STORE_KEY = 'ovfr:tile-manifest:v1'

export function enableTileManifestPersistence(store: TileManifestStore): void {
  state.store = store
  state.storedRead = null
}

/** True while the manifest in use is the stored copy (no fresh one fetched this session yet). */
export function isTileManifestFromStorage(): boolean {
  return state.fromStorage
}

function readStoredManifest(tilesBaseUrl: string): Promise<TileManifest | null> {
  const store = state.store
  if (!store) return Promise.resolve(null)
  if (state.storedRead?.base === tilesBaseUrl) return state.storedRead.p
  const p = (async () => {
    try {
      const raw = await store.getItem(STORE_KEY)
      if (!raw) return null
      const v = JSON.parse(raw) as { base?: string; manifest?: unknown }
      // Per tile host: a stored manifest of another host (staging / production) names other content.
      return v.base === tilesBaseUrl ? sanitizeManifest(v.manifest) : null
    } catch { return null }
  })()
  state.storedRead = { base: tilesBaseUrl, p }
  return p
}

function writeStoredManifest(tilesBaseUrl: string, manifest: TileManifest): void {
  const store = state.store
  if (!store) return
  state.storedRead = { base: tilesBaseUrl, p: Promise.resolve(manifest) }
  try { void Promise.resolve(store.setItem(STORE_KEY, JSON.stringify({ base: tilesBaseUrl, manifest }))).catch(() => undefined) }
  catch { /* storage unavailable: nothing to keep */ }
}

/** The one fallback when no manifest could be fetched: the stored copy, if any and nothing better arrived meanwhile. */
async function adoptStoredIfNone(tilesBaseUrl: string): Promise<void> {
  if (state.manifest) return
  const stored = await readStoredManifest(tilesBaseUrl)
  if (stored && !state.manifest) adoptManifest(stored, true)
}

/** The one "did the content change" rule: any file added, removed or with another hash. */
function filesDiffer(a: TileManifest, b: TileManifest): boolean {
  const an = a.files ?? {}, bn = b.files ?? {}
  const names = new Set([...Object.keys(an), ...Object.keys(bn)])
  for (const n of names) if (an[n]?.sha256 !== bn[n]?.sha256) return true
  return false
}

/** Makes `data` the manifest in use; the only place that notifies listeners. */
function adoptManifest(data: TileManifest, fromStorage: boolean): void {
  const prev = state.manifest
  state.manifest = data
  state.fromStorage = fromStorage
  if (prev === null) {
    if (state.unversionedIssued) { state.unversionedIssued = false; notifyListeners('versioned') }
  } else if (filesDiffer(prev, data)) {
    notifyListeners('update')
  }
}

function notifyListeners(reason: TileManifestChangeReason): void {
  changeListeners.forEach((listener) => {
    try { listener(reason) } catch (err) { console.warn('[tileManifest] change listener failed:', err) }
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
  if (state.load) return state.load
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ac ? setTimeout(() => ac.abort(), MANIFEST_FETCH_TIMEOUT_MS) : null
  const p: Promise<void> = fetch(`${tilesBaseUrl}/manifest.json`, { cache: 'no-store', ...(ac ? { signal: ac.signal } : {}) })
    .then(res => (res.ok ? res.json() as Promise<unknown> : null))
    .catch(() => null)
    .then((raw) => {
      if (state.load !== p) return            // superseded by a newer load (refreshTileManifest): never overwrite it
      const data = sanitizeManifest(raw)
      if (data) {
        adoptManifest(data, false)
        writeStoredManifest(tilesBaseUrl, data)
        return
      }
      // A failed refetch keeps the manifest already known: its versioned URLs still name consistent content, while
      // dropping it would send every later fetch to the unversioned URL. With none at all: the stored copy, if any.
      return adoptStoredIfNone(tilesBaseUrl)
    })
    .finally(() => { if (timer) clearTimeout(timer) })
  state.load = p
  return p
}

/** Force a re-fetch (e.g. a user-triggered "check for updates" action). */
export function refreshTileManifest(tilesBaseUrl: string): Promise<void> {
  state.load = null
  return loadTileManifest(tilesBaseUrl)
}

/**
 * Waits for the manifest to resolve (reusing loadTileManifest()'s own
 * dedup'd promise) OR a bounded timeout, whichever comes first. Never
 * rejects -- a timeout or fetch failure just means callers proceed with
 * whatever manifest is already in memory (none, or a previous one), exactly
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
  // Whoever goes on without a manifest uses unversioned URLs: remember it, so the first manifest that arrives later
  // notifies listeners (`versioned`).
  const markIfNone = () => { if (!state.manifest) state.unversionedIssued = true }
  // No wait when a manifest is known (also during a background refetch). Otherwise one shared bounded wait per load:
  // a missing or hanging manifest costs one wait, not one per fetch (and later callers get the finished wait at once).
  if (state.manifest) return Promise.resolve()
  if (state.wait?.load === load) return state.wait.p.then(markIfNone)
  const p = new Promise<void>((resolve) => {
    let finished = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const finish = () => {
      if (finished) return
      finished = true
      timers.forEach(clearTimeout)
      markIfNone()
      resolve()
    }
    void load.then(finish)
    // With a stored copy, the network gets a short grace only; the fresh manifest replaces the stored one on arrival.
    if (state.store) {
      timers.push(setTimeout(() => { void adoptStoredIfNone(tilesBaseUrl).then(() => { if (state.manifest) finish() }) },
        Math.min(timeoutMs, STORED_GRACE_MS)))
    }
    timers.push(setTimeout(() => { void adoptStoredIfNone(tilesBaseUrl).then(finish) }, timeoutMs))
  })
  state.wait = { load, p }
  return p
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
 * module state for the rest of that session's lifetime.
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
 * The listener gets a reason: `update` for a content change (any manifest
 * refresh, polling or not, that names other content; also a stored copy
 * replaced by a newer fetched one), `versioned` once when the FIRST manifest
 * of the session arrives after unversioned fallback URLs were handed out
 * (manifest slow or failed at start). `versioned` is no data change: caches
 * keyed by URL reload, but a "new data available" prompt must ignore it.
 *
 * This module does not decide WHAT to do about a change (reload immediately,
 * hot-swap sources, prompt the user) -- callers do that (see
 * `TileUpdatePrompt.tsx`'s simple "reload on user tap" choice, the safest
 * option given re-adding already-mounted PMTiles sources mid-session risks
 * partial/inconsistent map state).
 */
export function onTileManifestChanged(listener: ManifestChangeListener): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
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
    void refreshTileManifest(tilesBaseUrl)                    // a change notifies listeners (adoptManifest)
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
  return state.manifest
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
  const entry = state.manifest?.files?.[filename]
  const base = `${tilesBaseUrl}/${filename}`
  return entry ? `${base}?v=${entry.sha256.slice(0, 12)}` : base
}

