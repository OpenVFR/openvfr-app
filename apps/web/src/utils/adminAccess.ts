/**
 * Whether the signed-in account is an admin (`role = 'admin'` on the session), for features that are open to admins on a
 * deployment where the build flag is off. App.tsx keeps it in step with the session; components read it with the hooks below.
 *
 * This only decides what the UI shows. Whatever must stay admin-only is enforced on the server too (the charts document endpoint:
 * CHART_DOCUMENT_ADMIN_ONLY).
 */
import { useSyncExternalStore } from 'react'
import { EXPERIMENTAL_CHARTS } from './env'

let admin = false
const listeners = new Set<() => void>()

export function setAdminSession(isAdmin: boolean): void {
  if (admin === isAdmin) return
  admin = isAdmin
  listeners.forEach(l => l())
}

export const isAdminSession = (): boolean => admin
export const subscribeAdminSession = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** The rule: the build flag opens charts for everyone, an admin session opens them where the flag is off. */
export const chartsOpen = (buildFlag: boolean, isAdmin: boolean): boolean => buildFlag || isAdmin

export function useIsAdmin(): boolean {
  return useSyncExternalStore(subscribeAdminSession, isAdminSession, () => false)
}

/** Official charts (list, viewer, georeferenced VAC overlay): on for everyone when the build flag is on, else for admins. */
export function useChartsEnabled(): boolean {
  return chartsOpen(EXPERIMENTAL_CHARTS, useIsAdmin())
}
