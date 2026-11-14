/**
 * useResilientTileData — retry-with-backoff loader for the app's static
 * per-country GeoJSON overlay files (aerodromes, airspace, navaids, etc.).
 *
 * BUG THIS FIXES: <GeoJSONSource data={someRemoteUrl}> hands the URL
 * straight to MapLibre Native's own (Java/Kotlin) HTTP stack, which does
 * NOT retry on failure the way every other one-shot network call in this
 * app does (see fetchWithRetry's doc comment / AGENTS.md's "brief
 * connectivity gaps must be tolerated everywhere" gotcha). A single dropped
 * packet or Cloudflare edge hiccup surfaces in logcat as e.g. "Failed to
 * load source ofm-aerodromes: timeout" or "...stream was reset:
 * INTERNAL_ERROR" and then just... stays failed — the source never
 * retries, so its features (aerodromes, airspace, etc.) silently vanish
 * from the map for the rest of that app session, with no user-visible
 * error and no way to recover short of a full reload. Confirmed live on
 * device: identical Wi-Fi, identical URL, curl from a workstation on the
 * same network succeeds instantly and repeatedly — this is a transient
 * gap on the device's own connection/OkHttp stack, exactly the class of
 * problem fetchWithRetry exists to paper over, just never wired up for
 * MapLibre's own source fetches before now.
 *
 * Fix, chosen to add zero risk to the (much more common) happy path: we
 * keep handing MapLibre the raw URL immediately, unchanged, so a
 * successful native load looks and behaves exactly as it did before. In
 * parallel we ALSO fetch the same URL ourselves via fetchWithRetry (2
 * retries, exponential backoff). If that JS-side fetch succeeds, we swap
 * the source's `data` prop from the URL to the already-parsed GeoJSON
 * object — MapLibre treats that as a plain local data update (no network
 * involved) and immediately (re)renders the features. Net effect: if
 * native's own fetch already succeeded, this is a harmless no-op re-set of
 * identical data; if native's fetch failed and left the source empty, this
 * self-heals it moments later without any user action or app reload. The
 * cost is one redundant fetch of a small (<1MB) static file per source per
 * app session — cached at module scope (see below) so it only happens once.
 *
 * Local file:// URIs (offline-cached assets, see offlineCache.ts) are
 * passed straight through unchanged, with no parallel fetch — those are
 * disk reads, not network requests, so there's nothing to retry, and RN's
 * fetch() does not reliably support the file:// scheme across platforms.
 *
 * Cached per-URL at module scope (same pattern as wxStations.ts's
 * loadStations cache) so repeated remounts — a Fast Refresh during dev, a
 * screen re-mount, a basemap swap — don't re-fetch data already fetched
 * successfully this session.
 */
import { useEffect, useState } from 'react'
import type { GeoJSON } from 'geojson'
import { fetchWithRetry } from '@open-vfr/shared/fetchWithRetry'
import { onTileManifestChanged } from '@open-vfr/shared/tileManifest'
import { isOutdatedTileUrl } from '../utils/geoJsonCache'

const cache = new Map<string, GeoJSON>()
// Keyed by URL: on a manifest change drop the entries of outdated versions (memory), like ../utils/geoJsonCache.
onTileManifestChanged(() => { for (const url of [...cache.keys()]) if (isOutdatedTileUrl(url)) cache.delete(url) })
const inFlight = new Map<string, Promise<GeoJSON>>()

export function isRemote(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/** What a source shows while its remote URL may not be versioned yet. Stable reference (memoized consumers). */
const EMPTY_FC: GeoJSON = { type: 'FeatureCollection', features: [] }

function loadOnce(url: string): Promise<GeoJSON> {
  const existing = inFlight.get(url)
  if (existing) return existing

  const promise = (async () => {
    const resp = await fetchWithRetry(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${url}`)
    const json = (await resp.json()) as GeoJSON
    cache.set(url, json)
    return json
  })()
  inFlight.set(url, promise)
  // Both outcomes clear the entry; the caller handles the rejection (a bare .finally() left an unhandled one).
  const clear = () => { inFlight.delete(url) }
  promise.then(clear, clear)
  return promise
}

/**
 * Resolves a tile URL for <GeoJSONSource data={...}>.
 *
 * A local file:// URI is returned as is (the renderer reads it). A remote URL
 * is returned as is while our own retried fetch is in flight (MapLibre loads
 * it directly meanwhile), then as the parsed GeoJSON from the module cache.
 * `remoteReady` false: a remote URL is not used at all yet (no fetch, and the
 * source gets an empty collection instead of the URL, so MapLibre does not
 * fetch it either). Pass false until the tile manifest has been waited for:
 * before that the URL is unversioned.
 */
export function useResilientTileData(url: string, remoteReady = true): string | GeoJSON {
  // Re-render trigger only: the data itself is read from the module cache below.
  const [, setLoaded] = useState(0)

  useEffect(() => {
    if (!isRemote(url) || !remoteReady) return
    const cached = cache.get(url)
    if (cached) return
    let cancelled = false
    loadOnce(url)
      .then(() => { if (!cancelled) setLoaded(n => n + 1) })
      .catch(() => { /* leave the raw URL in place — MapLibre's own (possibly
                         already-successful) load is the only fallback left */ })
    return () => { cancelled = true }
  }, [url, remoteReady])

  if (!isRemote(url)) return url
  if (!remoteReady) return EMPTY_FC
  return cache.get(url) ?? url
}
