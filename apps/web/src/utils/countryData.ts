/**
 * Web wiring for @open-vfr/shared/countryData: per-country tile files are
 * fetched from TILES_BASE_URL with manifest-versioned URLs (each load waits
 * for the manifest first), and the active
 * countries start as the saved Settings selection (so the very first data
 * fetches already use it) and follow useCountries() afterwards.
 *
 * Import once, early (main.tsx), before anything loads country data.
 */
import { useEffect, useState } from 'react'
import {
  configureCountryData, setActiveCountries, getActiveCountries, onActiveCountriesChange, invalidateCountryData,
} from '@open-vfr/shared/countryData'
import { resolveSelectedCountries, type AvailableCountry } from '@open-vfr/shared/countries'
import { versionedTileUrl, waitForTileManifest, onTileManifestChanged } from '@open-vfr/shared/tileManifest'
import { TILES_BASE_URL } from './env'

// Same keys as hooks/useCountries.ts.
export const K_COUNTRIES_AVAILABLE = 'ovfr:countries:available'
export const K_COUNTRIES_SELECTED  = 'ovfr:countries:selected'

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch { return null }
}

// Every load waits for the tile manifest (bounded, see waitForTileManifest), so even the first fetches after start use
// versioned URLs. A manifest change (a data update, or the first manifest after a start that went on without one) empties
// the dataset cache so nothing loaded from an older or unversioned URL is handed out again.
configureCountryData({
  resolveUrl: (fileName) => versionedTileUrl(TILES_BASE_URL, fileName),
  whenReady: () => waitForTileManifest(TILES_BASE_URL),
})
onTileManifestChanged(invalidateCountryData)
setActiveCountries(resolveSelectedCountries(
  readJson<string[]>(K_COUNTRIES_SELECTED) ?? [],
  readJson<AvailableCountry[]>(K_COUNTRIES_AVAILABLE),
))

/**
 * Active countries, re-rendering on change. Use the returned key as an
 * effect dependency wherever country data is loaded, so a new selection
 * reloads it.
 */
export function useActiveCountries(): { countries: string[]; key: string } {
  const [countries, setCountries] = useState(getActiveCountries)
  useEffect(() => {
    setCountries(getActiveCountries())
    return onActiveCountriesChange(setCountries)
  }, [])
  return { countries, key: countries.join(',') }
}
