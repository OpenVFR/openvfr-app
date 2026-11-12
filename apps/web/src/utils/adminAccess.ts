/**
 * Whether the signed-in account is an admin (`role = 'admin'` on the session), for admin-only features (official charts, the
 * unreviewed curated data). App.tsx keeps it in step with the session; components read it with the hooks below.
 *
 * This only decides what the UI shows. Whatever must stay admin-only is enforced on the server too (the charts document endpoint:
 * CHART_DOCUMENT_ADMIN_ONLY).
 */
import { useSyncExternalStore } from 'react'

let admin = false
const listeners = new Set<() => void>()

export function setAdminSession(isAdmin: boolean): void {
  if (admin === isAdmin) return
  admin = isAdmin
  listeners.forEach(l => l())
}

export const isAdminSession = (): boolean => admin
export const subscribeAdminSession = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function useIsAdmin(): boolean {
  return useSyncExternalStore(subscribeAdminSession, isAdminSession, () => false)
}

/** Official charts (list, viewer, georeferenced VAC overlay): admins only (the API refuses everyone else too: CHART_DOCUMENT_ADMIN_ONLY). */
export function useChartsEnabled(): boolean {
  return useIsAdmin()
}
