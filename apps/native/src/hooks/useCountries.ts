/**
 * Countries the deployment serves (GET /api/countries) and the user's
 * selection among them -- module-level store so Settings and the map stay
 * in sync, persisted via the settings db. Same semantics as web's
 * useCountries (see @open-vfr/shared/countries):
 *   available -- last list the server returned (kept for offline starts)
 *   selected  -- effective selection, never empty while anything is available
 */
import { useEffect, useMemo, useState } from 'react'
import {
  fetchAvailableCountries, resolveSelectedCountries, type AvailableCountry,
} from '@open-vfr/shared/countries'
import { settings as db } from '../db'
import { API_BASE } from '../config'

const K_AVAILABLE = 'countries_available'
const K_SELECTED  = 'countries_selected'
const REFRESH_MS  = 30 * 60 * 1000

interface State { available: AvailableCountry[] | null; saved: string[] }

let state: State = { available: null, saved: [] }
let started = false
const listeners = new Set<(s: State) => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l(state))
}

async function refresh() {
  try {
    const list = await fetchAvailableCountries(API_BASE)
    if (!list) return
    set({ available: list })
    void db.set(K_AVAILABLE, list)
  } catch (err) {
    console.warn('[useCountries] refresh failed:', err)
  }
}

function start() {
  if (started) return
  started = true
  Promise.all([
    db.get<AvailableCountry[]>(K_AVAILABLE),
    db.get<string[]>(K_SELECTED),
  ]).then(([available, saved]) => {
    // A server answer that arrived first wins over the stored list.
    set({
      available: state.available ?? (Array.isArray(available) ? available : null),
      saved: Array.isArray(saved) ? saved : [],
    })
  }).catch(() => {}).finally(() => { void refresh() })
  setInterval(() => { void refresh() }, REFRESH_MS)
}

export function setSelectedCountries(codes: string[]) {
  set({ saved: codes })
  void db.set(K_SELECTED, codes)
}

export function useCountries(): {
  available: AvailableCountry[] | null
  selected: string[]
  setSelected: (codes: string[]) => void
} {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    start()
    setS(state)
    return () => { listeners.delete(setS) }
  }, [])
  // Joined key keeps the array identity stable across unrelated renders.
  const selectedKey = resolveSelectedCountries(s.saved, s.available).join(',')
  const selected = useMemo(() => (selectedKey ? selectedKey.split(',') : []), [selectedKey])
  return { available: s.available, selected, setSelected: setSelectedCountries }
}
