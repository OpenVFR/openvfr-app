/**
 * Per-country aviation data, merged across the active countries.
 *
 * The data pipeline publishes one file per country and dataset
 * (`<cc>-airspace.geojson`, `<cc>-aerodromes.geojson`, ...). Every consumer
 * that used to fetch Sweden's file now calls loadCountryGeojson(kind),
 * which fetches that dataset for every active country and merges the
 * features into one FeatureCollection, so map layers, lookups, warnings and
 * search work across all selected countries without each caller looping
 * over countries itself.
 *
 * Shared by web and native. Each platform calls configureCountryData() once
 * at startup with how to turn a file name into a URL (manifest-versioned
 * remote URL, or a cached local file on native) and keeps the active list
 * current with setActiveCountries() (from the Settings selection).
 */
import type { Feature, FeatureCollection } from 'geojson'
import { DEFAULT_REGION_CODES } from './regions'

export type CountryDataset =
  | 'airspace' | 'aerodromes' | 'navaids' | 'waypoints' | 'runways'
  | 'runwayThresholds' | 'obstacles' | 'landmarks' | 'water' | 'lakes' | 'aeroways' | 'aerodromeDetails'
  | 'aerodromesPreview' | 'aerodromeDetailsPreview' | 'charts' | 'chartsPreview'

const SUFFIX: Record<CountryDataset, string> = {
  airspace:         'airspace.geojson',
  aerodromes:       'aerodromes.geojson',
  navaids:          'navaids.geojson',
  waypoints:        'waypoints.geojson',
  runways:          'runways.geojson',
  runwayThresholds: 'runway-thresholds.geojson',
  obstacles:        'obstacles.geojson',
  landmarks:        'landmarks.geojson',
  water:            'water.geojson',   // every lake: no app reads it (admin dataset status, older native builds' offline download)
  // Large lakes only, simplified (a few hundred KB): what the glide check needs, instead of `water`.
  lakes:            'lakes.geojson',
  aeroways:         'aeroways.geojson',
  // Circuits, noise-sensitive areas, holdings and club-map features (experimental, may be absent): see aerodromeDetails.ts.
  aerodromeDetails: 'aerodrome-details.geojson',
  // The same two files with every airfield's unreviewed curated values too (marked). Only admins can switch them on (the app's
  // Settings); never the core map behaviour reads them, only the informational layer.
  aerodromesPreview: 'aerodromes.preview.geojson',
  aerodromeDetailsPreview: 'aerodrome-details.preview.geojson',
  // The official-charts indexes (not GeoJSON: read with the charts loader, not loadCountryGeojson). `charts` = the released airfields'
  // charts, what every user reads; `chartsPreview` = every airfield's, read by an admin session that switched on unreviewed data.
  // Like the preview GeoJSON files it is published on the tile host, so anyone who knows the URL can read it: the switch is a view
  // choice and the chart document endpoint only serves unreleased charts to admins; it is not secrecy. (Renamed from `charts.json`:
  // a deployment still publishing the old name has no charts until it publishes these two.)
  charts: 'charts.public.json',
  chartsPreview: 'charts.preview.json',
}

export type CountryArchive = 'basemap' | 'landuse' | 'hillshade' | 'contours'

/** File name of one country's dataset, e.g. ('se', 'runwayThresholds') -> 'se-runway-thresholds.geojson'. */
export function countryDatasetFile(country: string, kind: CountryDataset): string {
  return `${country}-${SUFFIX[kind]}`
}

/** File name of one country's PMTiles archive, e.g. ('se', 'basemap') -> 'se-basemap.pmtiles'. */
export function countryArchiveFile(country: string, kind: CountryArchive): string {
  return `${country}-${kind}.pmtiles`
}

/** File name of one country's grid-maximum-elevation file, e.g. 'se' -> 'se-mef.mef' (see infra scripts/mef_format.py). */
export function countryMefFile(country: string): string {
  return `${country}-mef.mef`
}

export interface CountryDataConfig {
  /** File name -> URL to fetch (e.g. manifest-versioned tile URL, or a local file URI). */
  resolveUrl: (fileName: string) => string
  /** Optional fetch override (tests, platform quirks). Defaults to global fetch + json(). */
  fetchJson?: (url: string) => Promise<unknown>
  /**
   * Resolves once resolveUrl() returns final URLs (web: the tile manifest has loaded, or its bounded wait ran out). Awaited
   * before every load, so no file is fetched from an unversioned URL just because the manifest was still on its way. Must
   * never reject or hang without bound.
   */
  whenReady?: () => Promise<void>
}

let _config: CountryDataConfig | null = null
let _active: string[] = [...DEFAULT_REGION_CODES]
const _listeners = new Set<(countries: string[]) => void>()
const _cache = new Map<string, Promise<FeatureCollection>>()

export function configureCountryData(config: CountryDataConfig): void {
  _config = config
  _cache.clear()
}

/** Countries whose data is loaded and shown. Sorted, de-duplicated. */
export function getActiveCountries(): string[] {
  return _active
}

/** Stable string for the active set, for React deps / cache keys. */
export function activeCountriesKey(): string {
  return _active.join(',')
}

export function setActiveCountries(countries: readonly string[]): void {
  const next = [...new Set(countries)].sort()
  if (next.join(',') === _active.join(',')) return
  _active = next
  _listeners.forEach(l => l(next))
}

export function onActiveCountriesChange(listener: (countries: string[]) => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}

/**
 * Drops the cached datasets loaded from a URL that is no longer the current one for its file (an older version, or an
 * unversioned fallback from a start without the manifest), so the next load fetches them again; unchanged files stay
 * cached. The platform wiring calls it when the tile manifest changes.
 */
export function invalidateCountryData(): void {
  if (!_config) { _cache.clear(); return }
  for (const key of [..._cache.keys()]) {
    const urls = key.split('|').slice(1)
    const fileOf = (u: string) => (u.split('?')[0] ?? '').split('/').pop() ?? ''
    if (urls.some(u => countryFileUrl(fileOf(u)) !== u)) _cache.delete(key)
  }
}

/** URL of one country file via the configured resolver. Synchronous: may not be final yet; fetch with countryFileUrlReady(). */
export function countryFileUrl(fileName: string): string {
  if (!_config) throw new Error('configureCountryData() has not been called')
  return _config.resolveUrl(fileName)
}

/** Waits until the configured URLs are final (see CountryDataConfig.whenReady). Rejects only when configureCountryData()
 *  has not been called (a setup error, like countryFileUrl's throw); a whenReady failure never rejects. */
export function countryDataReady(): Promise<void> {
  if (!_config) return Promise.reject(new Error('configureCountryData() has not been called'))
  return _config.whenReady ? _config.whenReady().catch(() => undefined) : Promise.resolve()
}

/** URL of one country file for fetching it: waits for final URLs first (see CountryDataConfig.whenReady). */
export async function countryFileUrlReady(fileName: string): Promise<string> {
  await countryDataReady()
  return countryFileUrl(fileName)
}

async function fetchJson(url: string): Promise<unknown> {
  if (_config?.fetchJson) return _config.fetchJson(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

// Countries' extracts can overlap at borders (shared airspace, border
// aerodromes). Same geometry + same identifying property = same feature.
function featureKey(f: Feature): string {
  const p = (f.properties ?? {}) as Record<string, unknown>
  const id = p['icao'] ?? p['id'] ?? p['name'] ?? ''
  return `${String(id)}|${p['lower_ft'] ?? ''}|${p['upper_ft'] ?? ''}|${JSON.stringify(f.geometry)}`
}

/** Concatenate FeatureCollections, dropping exact duplicates (see featureKey). */
export function mergeFeatureCollections(collections: readonly FeatureCollection[]): FeatureCollection {
  if (collections.length === 1) return collections[0]!
  const seen = new Set<string>()
  const features: Feature[] = []
  for (const fc of collections) {
    for (const f of fc.features) {
      const k = featureKey(f)
      if (seen.has(k)) continue
      seen.add(k)
      features.push(f)
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * One dataset for the given countries (default: the active ones), merged.
 * Waits for final URLs first (CountryDataConfig.whenReady), so the very
 * first loads after start use the manifest-versioned URLs too. Cached per
 * resolved URL set, so a data update (new manifest version) or a different
 * country selection loads fresh data; invalidateCountryData() empties the
 * cache when the manifest changes. A country whose file
 * fails to load is skipped (logged); only if every country fails does the
 * promise reject.
 */
export async function loadCountryGeojson(
  kind: CountryDataset,
  countries: readonly string[] = _active,
): Promise<FeatureCollection> {
  const snapshot = [...countries]
  await countryDataReady()
  return loadResolved(kind, snapshot)
}

function loadResolved(kind: CountryDataset, countries: readonly string[]): Promise<FeatureCollection> {
  const urls = countries.map(c => countryFileUrl(countryDatasetFile(c, kind)))
  const key = `${kind}|${urls.join('|')}`
  let p = _cache.get(key)
  if (!p) {
    p = Promise.allSettled(urls.map(u => fetchJson(u))).then((results) => {
      const ok: FeatureCollection[] = []
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value && Array.isArray((r.value as FeatureCollection).features)) {
          ok.push(r.value as FeatureCollection)
        } else {
          console.warn(`[countryData] ${kind} for ${countries[i]} failed to load:`, r.status === 'rejected' ? r.reason : 'not a FeatureCollection')
        }
      })
      if (ok.length === 0 && urls.length > 0) throw new Error(`No ${kind} data could be loaded`)
      return ok.length === 0 ? { type: 'FeatureCollection', features: [] } : mergeFeatureCollections(ok)
    })
    // A failed load must not stick: next call retries.
    p.catch(() => { if (_cache.get(key) === p) _cache.delete(key) })
    _cache.set(key, p)
  }
  return p
}

/**
 * A cache-key + loader pair for modules that keep their own derived cache
 * (e.g. airspaceQuery): the key changes whenever the merged data would.
 */
export interface DatasetSource {
  key: string
  load: () => Promise<FeatureCollection>
}

/** The key is built from the URLs known now (it may still be unversioned right after start); load() waits for final URLs, and the
 *  key changes once they are known, so a derived cache built from an early load is rebuilt then. */
export function countryDatasetSource(kind: CountryDataset, countries: readonly string[] = _active): DatasetSource {
  const snapshot = [...countries]
  const urls = snapshot.map(c => countryFileUrl(countryDatasetFile(c, kind)))
  return { key: `${kind}|${urls.join('|')}`, load: () => loadCountryGeojson(kind, snapshot) }
}
