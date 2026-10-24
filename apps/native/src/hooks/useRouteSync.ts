/**
 * useRouteSync — cloud sync state and change reporting for saved routes.
 *
 * The sync itself (two-way, offline-safe, deletes included) runs in
 * ../sync/cloudSync.ts; this hook only exposes it to the route UI.
 * Callers write the route to AsyncStorage first, then report it:
 *   notifyRouteChanged()  after a create/edit
 *   deleteRoute(id)       after a local delete
 * Both are safe offline: the change is sent once the server is reachable.
 */

import { useCallback } from 'react'
import { notifyLocalChange, notifyLocalDelete, syncNow, useTableSync } from '../sync/cloudSync'
export function useRouteSync() {
  const { status } = useTableSync('user_routes')

  /** Run a sync round now (pull-to-refresh, library opened). */
  const pull = useCallback(() => syncNow('user_routes'), [])

  /** A saved route was created or edited (already written locally). */
  const notifyRouteChanged = useCallback(() => { notifyLocalChange('user_routes') }, [])

  /** A saved route was deleted locally. */
  const deleteRoute = useCallback((id: string) => notifyLocalDelete('user_routes', id), [])

  return { syncState: status, pull, notifyRouteChanged, deleteRoute }
}
