/**
 * useSync — runs two-way cloud sync for the signed-in account.
 *
 * The sync itself lives in ../sync/cloudSync.ts (on top of the shared engine
 * in @open-vfr/shared/cloudSync). This hook only ties it to the auth state:
 *   - sign-in: claim the local data for this account (wiping another
 *     account's), then start syncing (keyed on the user id only: sync gets
 *     its own PostgREST JWT and retries while offline);
 *   - sign-out: stop syncing, then wipe this account's local copy.
 *
 * Synced collections: routes, aircraft_profiles, user_waypoints, settings,
 * flight_logs (upload-only on the server; deletes propagate).
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { AuthState } from './useAuth'
import { getSyncOwner, setSyncOwner, isWipePending, clearPrivateLocalData } from '../db/userScope'
import {
  startCloudSync, stopCloudSync, getCloudSyncStatus, subscribeCloudSync, clearSyncLocalState,
  installChangeCapture,
} from '../sync/cloudSync'

export type SyncPushState = 'idle' | 'error' | 'offline'

/** Sync problem indicator: 'error' / 'offline' while changes could not be
 *  exchanged with the server, 'idle' otherwise (including while syncing). */
export function useSyncState(): SyncPushState {
  const status = useSyncExternalStore(subscribeCloudSync, getCloudSyncStatus)
  return status === 'error' || status === 'offline' ? status : 'idle'
}

export function useSync(auth: AuthState): void {
  const userId = auth.user?.id

  // Watch local edits from app start, before sign-in has resolved, so a
  // delete made while sync is still starting is not lost.
  useEffect(() => { void installChangeCapture() }, [])

  // After an explicit sign-out: stop syncing (waits for a running round),
  // then wipe the previous account's local data.
  useEffect(() => {
    if (userId || !isWipePending()) return
    let cancelled = false
    void (async () => {
      await stopCloudSync()
      if (!cancelled && isWipePending()) {
        await clearPrivateLocalData()
        clearSyncLocalState()
        // Route/aircraft state is also held in memory by the UI; a reload is
        // the reliable way to drop the previous account's copy.
        window.location.reload()
      }
    })()
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      // Local data left by a different account must never reach this one.
      const owner = getSyncOwner()
      if ((owner && owner !== userId) || isWipePending()) {
        await stopCloudSync()
        await clearPrivateLocalData()
        clearSyncLocalState()
        setSyncOwner(userId)
        window.location.reload()   // drop the other account's in-memory state
        return
      }
      setSyncOwner(userId)
      if (!cancelled) await startCloudSync(userId)
    })()
    return () => {
      cancelled = true
      void stopCloudSync()
    }
  }, [userId])
}
