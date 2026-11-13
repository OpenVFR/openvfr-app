/**
 * "Include unreviewed": an admin-only choice. Everyone else, and an admin who has not switched it on, sees approved curated data
 * and the charts of released airfields only. Stored on the device. It only ever selects which files the informational layer
 * reads (circuits, areas, the local-information text) and which charts index the charts section reads (the preview index also
 * lists the airfields that are not released); aerodrome symbols, closed flags and routing always use the public data.
 */
import { useSyncExternalStore } from 'react'
import { isAdminSession, subscribeAdminSession } from './adminAccess'

const KEY = 'ovfr:curated:unreviewed'

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

let preference = read()
const listeners = new Set<() => void>()

export function setUnreviewedPreference(on: boolean): void {
  if (preference === on) return
  preference = on
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode: lasts for this session */ }
  listeners.forEach(l => l())
}

export const getUnreviewedPreference = (): boolean => preference

/** The rule: only an admin session with the preference on. */
export const unreviewedActive = (admin: boolean, pref: boolean): boolean => admin && pref

/** Non-hook read for loaders. */
export const unreviewedShown = (): boolean => unreviewedActive(isAdminSession(), preference)

const subscribe = (l: () => void) => {
  listeners.add(l)
  const off = subscribeAdminSession(l)
  return () => { listeners.delete(l); off() }
}

/** Whether this session is showing unreviewed curated data. */
export function useUnreviewedShown(): boolean {
  return useSyncExternalStore(subscribe, unreviewedShown, () => false)
}

export function useUnreviewedPreference(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, getUnreviewedPreference, () => false), setUnreviewedPreference]
}
