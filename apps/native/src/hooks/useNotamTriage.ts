/**
 * The pilot's read / hidden marks on NOTAMs (see @open-vfr/shared/notamTriage):
 * a module-level store so every mounted list stays in sync, persisted via the
 * settings db like useNotamPrefs.
 *
 * Nothing is written until the stored marks have been read, so a mark made
 * while loading cannot overwrite them; after a successful load the merged
 * list is written once. A failed load is retried on the next mount and the
 * marks stay in memory meanwhile.
 */
import { useEffect, useState } from 'react'
import { EMPTY_TRIAGE, hide as hideKey, markRead as readKey, parseTriage, unhide as unhideKey, type NotamTriage } from '@open-vfr/shared/notamTriage'
import { settings as db } from '../db'

const KEY = 'notam_triage'
let state: NotamTriage = EMPTY_TRIAGE
let loadState: 'idle' | 'loading' | 'ok' = 'idle'
const listeners = new Set<(s: NotamTriage) => void>()

function persist() {
  if (loadState !== 'ok') return
  db.set(KEY, state).catch((e) => console.warn('NOTAM marks not saved', e))
}

function set(next: NotamTriage) {
  if (next === state) return
  state = next
  listeners.forEach((l) => l(state))
  persist()
}

const unique = (a: string[]) => [...new Set(a)]

function load() {
  if (loadState !== 'idle') return
  loadState = 'loading'
  db.get<unknown>(KEY).then((stored) => {
    const parsed = parseTriage(stored)
    // Marks made before the load finished come last (newest).
    state = parseTriage({ read: unique([...parsed.read, ...state.read]), hidden: unique([...parsed.hidden, ...state.hidden]) })
    loadState = 'ok'
    listeners.forEach((l) => l(state))
    persist()
  }).catch((e) => {
    console.warn('NOTAM marks not loaded', e)
    loadState = 'idle'
  })
}

const actions = {
  markRead: (key: string) => set(readKey(state, key)),
  hide: (key: string) => set(hideKey(state, key)),
  unhide: (key: string) => set(unhideKey(state, key)),
}

export function useNotamTriage() {
  const [triage, setTriage] = useState(state)
  useEffect(() => {
    listeners.add(setTriage)
    load()
    return () => { listeners.delete(setTriage) }
  }, [])
  return { triage, ...actions }
}
