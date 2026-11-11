/**
 * The pilot's read / hidden marks on NOTAMs (see @open-vfr/shared/notamTriage):
 * a module-level store so every mounted list stays in sync, persisted via the
 * settings db like useNotamPrefs.
 */
import { useEffect, useState } from 'react'
import { EMPTY_TRIAGE, hide, markRead, parseTriage, unhide, type NotamTriage } from '@open-vfr/shared/notamTriage'
import { settings as db } from '../db'

const KEY = 'notam_triage'
let state: NotamTriage = EMPTY_TRIAGE
let loaded = false
const listeners = new Set<(s: NotamTriage) => void>()

function set(next: NotamTriage) {
  if (next === state) return
  state = next
  listeners.forEach((l) => l(state))
  void db.set(KEY, state)
}

export function useNotamTriage() {
  const [triage, setTriage] = useState(state)
  useEffect(() => {
    listeners.add(setTriage)
    if (!loaded) {
      loaded = true
      db.get<unknown>(KEY).then((stored) => {
        if (!stored) return
        const parsed = parseTriage(stored)
        // Marks made before the load finished win over the stored ones.
        const merged = { read: [...parsed.read, ...state.read], hidden: [...parsed.hidden, ...state.hidden] }
        state = parseTriage(merged)
        listeners.forEach((l) => l(state))
      }).catch(() => {})
    }
    return () => { listeners.delete(setTriage) }
  }, [])
  return {
    triage,
    markRead: (key: string) => set(markRead(state, key)),
    hide: (key: string) => set(hide(state, key)),
    unhide: (key: string) => set(unhide(state, key)),
  }
}
