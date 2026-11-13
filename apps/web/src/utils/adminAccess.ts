/**
 * Whether the signed-in account is an admin (`role = 'admin'` on the session), for admin-only features (official charts, the
 * unreviewed curated data and charts). App.tsx keeps it in step with the session; components read it with the hooks below.
 *
 * This only decides what the UI shows. Whatever must stay admin-only is enforced on the server too (the charts document endpoint
 * serves a chart missing from the public index to admins only).
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

/**
 * Official charts (list, viewer, georeferenced VAC overlay) are shown to everyone: the public index only lists released airfields'
 * charts. What is not released is admin-only: the preview index (unreviewed.ts: "Include unreviewed") and, on the server, the
 * document endpoint. Kept as a hook so a deployment can switch charts off in one place.
 */
export function useChartsEnabled(): boolean {
  return true
}
