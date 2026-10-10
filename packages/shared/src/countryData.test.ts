import { describe, it, expect, beforeEach } from 'vitest'
import type { FeatureCollection } from 'geojson'
import {
  configureCountryData, setActiveCountries, getActiveCountries, loadCountryGeojson,
  countryDatasetFile, countryArchiveFile, mergeFeatureCollections, countryDatasetSource,
  onActiveCountriesChange,
} from './countryData'

const fc = (...features: FeatureCollection['features']): FeatureCollection => ({ type: 'FeatureCollection', features })
const pt = (icao: string, lon: number, lat: number) => ({
  type: 'Feature' as const, properties: { icao }, geometry: { type: 'Point' as const, coordinates: [lon, lat] },
})

const files: Record<string, unknown> = {
  'se-aerodromes.geojson': fc(pt('ESSA', 17.9, 59.6), pt('EKCH', 12.6, 55.6)),
  'dk-aerodromes.geojson': fc(pt('EKCH', 12.6, 55.6), pt('EKBI', 9.2, 55.7)),
}
let fetched: string[] = []

beforeEach(() => {
  fetched = []
  configureCountryData({
    resolveUrl: (f) => `https://tiles/${f}`,
    fetchJson: async (url) => {
      fetched.push(url)
      const name = url.replace('https://tiles/', '')
      if (!(name in files)) throw new Error('404')
      return files[name]
    },
  })
  setActiveCountries(['se'])
})

describe('file names', () => {
  it('builds per-country names', () => {
    expect(countryDatasetFile('se', 'runwayThresholds')).toBe('se-runway-thresholds.geojson')
    expect(countryArchiveFile('no', 'basemap')).toBe('no-basemap.pmtiles')
  })
})

describe('active countries', () => {
  it('sorts, de-duplicates and notifies only on change', () => {
    const seen: string[][] = []
    const off = onActiveCountriesChange(c => seen.push(c))
    setActiveCountries(['se', 'dk', 'se'])
    setActiveCountries(['dk', 'se'])
    off()
    expect(getActiveCountries()).toEqual(['dk', 'se'])
    expect(seen).toEqual([['dk', 'se']])
  })
})

describe('loadCountryGeojson', () => {
  it('merges countries and drops border duplicates', async () => {
    setActiveCountries(['se', 'dk'])
    const merged = await loadCountryGeojson('aerodromes')
    expect(merged.features.map(f => f.properties!['icao']).sort()).toEqual(['EKBI', 'EKCH', 'ESSA'])
  })
  it('caches per URL set', async () => {
    await loadCountryGeojson('aerodromes', ['se'])
    await loadCountryGeojson('aerodromes', ['se'])
    expect(fetched).toEqual(['https://tiles/se-aerodromes.geojson'])
  })
  it('skips a country whose file is missing', async () => {
    const merged = await loadCountryGeojson('aerodromes', ['se', 'no'])
    expect(merged.features).toHaveLength(2)
  })
  it('rejects when nothing loads, and retries next time', async () => {
    await expect(loadCountryGeojson('navaids', ['no'])).rejects.toThrow()
    await expect(loadCountryGeojson('navaids', ['no'])).rejects.toThrow()
    expect(fetched.filter(u => u.includes('no-navaids'))).toHaveLength(2)
  })
  it('source key changes with the country set', () => {
    expect(countryDatasetSource('airspace', ['se']).key).not.toBe(countryDatasetSource('airspace', ['se', 'dk']).key)
  })
})

describe('mergeFeatureCollections', () => {
  it('keeps distinct features with the same name but different geometry', () => {
    const m = mergeFeatureCollections([fc(pt('X', 1, 1)), fc(pt('X', 2, 2))])
    expect(m.features).toHaveLength(2)
  })
})
