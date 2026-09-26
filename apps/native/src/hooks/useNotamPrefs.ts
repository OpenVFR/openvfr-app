/**
 * NOTAM display preferences shared by every NOTAM list on native (aerodrome
 * popup, vicinity brief, airspace popup, map layers) -- module-level store
 * so all mounted consumers stay in sync, persisted via the settings db.
 * Same semantics as web's useNotamPrefs:
 *   textView -- Short / Full / Raw (see @open-vfr/shared/notamIcaoFormat)
 *   vfrOnly  -- hide IFR-only NOTAMs (default on)
 */
import { useEffect, useState } from 'react'
import type { NotamTextView } from '@open-vfr/shared/notamIcaoFormat'
import { settings as db } from '../db'

interface NotamPrefs { textView: NotamTextView; vfrOnly: boolean }

const KEY = 'notam_prefs'
let state: NotamPrefs = { textView: 'full', vfrOnly: true }
let loaded = false
const listeners = new Set<(s: NotamPrefs) => void>()

function set(patch: Partial<NotamPrefs>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l(state))
  void db.set(KEY, state)
}

export function useNotamPrefs() {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    if (!loaded) {
      loaded = true
      db.get<NotamPrefs>(KEY).then(stored => {
        if (stored) {
          state = {
            textView: stored.textView === 'short' || stored.textView === 'raw' ? stored.textView : 'full',
            vfrOnly: stored.vfrOnly !== false,
          }
          listeners.forEach(l => l(state))
        }
      }).catch(() => {})
    }
    return () => { listeners.delete(setS) }
  }, [])
  return {
    textView: s.textView,
    vfrOnly: s.vfrOnly,
    setTextView: (v: NotamTextView) => set({ textView: v }),
    setVfrOnly: (on: boolean) => set({ vfrOnly: on }),
  }
}
