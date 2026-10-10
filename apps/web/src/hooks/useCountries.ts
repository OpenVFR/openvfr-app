/**
 * Countries the deployment serves (GET /api/countries) and the user's
 * selection among them, both persisted in localStorage.
 *
 * The available list is refreshed on start and every REFRESH_MS; the last
 * list seen is kept so the picker works offline. A country the server
 * stops listing drops out of the effective selection (the saved selection
 * keeps it, so it comes back if the country is re-enabled). See
 * @open-vfr/shared/countries for the resolution rules.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAvailableCountries, resolveSelectedCountries, type AvailableCountry,
} from '@open-vfr/shared/countries'
import { setActiveCountries } from '@open-vfr/shared/countryData'
import { API_BASE_URL } from '../utils/env'
import { K_COUNTRIES_AVAILABLE as K_AVAILABLE, K_COUNTRIES_SELECTED as K_SELECTED } from '../utils/countryData'
const REFRESH_MS  = 30 * 60 * 1000

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch { return null }
}

export interface CountriesState {
  /** Countries offered in Settings; null until a list has ever been loaded. */
  available: AvailableCountry[] | null
  /** Effective selection (never empty while anything is available). */
  selected: string[]
  setSelected: (codes: string[]) => void
}

export function useCountries(): CountriesState {
  const [available, setAvailable] = useState<AvailableCountry[] | null>(() => readJson(K_AVAILABLE))
  const [saved, setSaved] = useState<string[]>(() => readJson<string[]>(K_SELECTED) ?? [])

  useEffect(() => {
    const ac = new AbortController()
    async function refresh() {
      try {
        const list = await fetchAvailableCountries(API_BASE_URL, ac.signal)
        if (!list) return
        localStorage.setItem(K_AVAILABLE, JSON.stringify(list))
        setAvailable(list)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') console.warn('[useCountries] refresh failed:', err)
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => { ac.abort(); clearInterval(timer) }
  }, [])

  const setSelected = useCallback((codes: string[]) => {
    localStorage.setItem(K_SELECTED, JSON.stringify(codes))
    setSaved(codes)
  }, [])

  // Joined key keeps the array identity stable across unrelated renders.
  const selectedKey = resolveSelectedCountries(saved, available).join(',')
  const selected = useMemo(() => (selectedKey ? selectedKey.split(',') : []), [selectedKey])

  // Every country-data consumer follows the effective selection.
  useEffect(() => { setActiveCountries(selected) }, [selected])

  return { available, selected, setSelected }
}
