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
  | 'runwayThresholds' | 'obstacles' | 'landmarks' | 'water' | 'aeroways'

const SUFFIX: Record<CountryDataset, string> = {
  airspace:         'airspace.geojson',
  aerodromes:       'aerodromes.geojson',
  navaids:          'navaids.geojson',
  waypoints:        'waypoints.geojson',
  runways:          'runways.geojson',
  runwayThresholds: 'runway-thresholds.geojson',
  obstacles:        'obstacles.geojson',
  landmarks:        'landmarks.geojson',
  water:            'water.geojson',
  aeroways:         'aeroways.geojson',
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

export interface CountryDataConfig {
  /** File name -> URL to fetch (e.g. manifest-versioned tile URL, or a local file URI). */
  resolveUrl: (fileName: string) => string
  /** Optional fetch override (tests, platform quirks). Defaults to global fetch + json(). */
  fetchJson?: (url: string) => Promise<unknown>
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

/** URL of one country file via the configured resolver. */
export function countryFileUrl(fileName: string): string {
  if (!_config) throw new Error('configureCountryData() has not been called')
  return _config.resolveUrl(fileName)
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
 * Cached per resolved URL set, so a data update (new manifest version) or
 * a different country selection loads fresh data. A country whose file
 * fails to load is skipped (logged); only if every country fails does the
 * promise reject.
 */
export function loadCountryGeojson(
  kind: CountryDataset,
  countries: readonly string[] = _active,
): Promise<FeatureCollection> {
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

export function countryDatasetSource(kind: CountryDataset, countries: readonly string[] = _active): DatasetSource {
  const snapshot = [...countries]
  const urls = snapshot.map(c => countryFileUrl(countryDatasetFile(c, kind)))
  return { key: `${kind}|${urls.join('|')}`, load: () => loadCountryGeojson(kind, snapshot) }
}
