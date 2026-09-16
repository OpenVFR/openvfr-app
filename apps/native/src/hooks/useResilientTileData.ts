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

const cache = new Map<string, GeoJSON>()
const inFlight = new Map<string, Promise<GeoJSON>>()

function isRemote(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

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
  promise.finally(() => inFlight.delete(url))
  return promise
}

/**
 * Resolves a tile URL for <GeoJSONSource data={...}>.
 *
 * Returns the raw URL immediately for local file:// assets, or (on first
 * call for a given remote URL) while our own retried fetch is still in
 * flight — same "MapLibre loads it directly" behavior as before this hook
 * existed. Once our fetch resolves, subsequent renders (and all renders
 * after the first successful fetch of that URL, thanks to the module-scope
 * cache) return the already-parsed GeoJSON object instead.
 */
export function useResilientTileData(url: string): string | GeoJSON {
  const [resolved, setResolved] = useState<GeoJSON | undefined>(
    () => cache.get(url),
  )

  useEffect(() => {
    if (!isRemote(url)) return
    const cached = cache.get(url)
    if (cached) {
      setResolved(cached)
      return
    }
    let cancelled = false
    loadOnce(url)
      .then(json => { if (!cancelled) setResolved(json) })
      .catch(() => { /* leave the raw URL in place — MapLibre's own (possibly
                         already-successful) load is the only fallback left */ })
    return () => { cancelled = true }
  }, [url])

  if (!isRemote(url)) return url
  return resolved ?? url
}
