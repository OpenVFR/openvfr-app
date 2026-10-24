/**
 * useUserWaypointSync — user-saved waypoints (local AsyncStorage) with cloud
 * sync. Shared through UserWaypointContext.
 *
 * The sync itself (two-way, offline-safe, deletes included) runs in
 * ../sync/cloudSync.ts; this hook keeps the local list for the UI and
 * reports local edits to it.
 */

import { useState, useEffect, useCallback } from 'react'
import { waypoints as waypointsDb } from '../db'
import type { UserWaypointDocType } from '../types/db'
import { notifyLocalChange, notifyLocalDelete, syncNow, useTableSync } from '../sync/cloudSync'
export function useUserWaypointSync() {
  const { status, localVersion } = useTableSync('user_waypoints')
  const [waypoints, setWaypoints] = useState<UserWaypointDocType[]>([])

  const refresh = useCallback(async () => {
    setWaypoints(await waypointsDb.getAll())
  }, [])

  useEffect(() => { void refresh() }, [refresh, localVersion])

  const pull = useCallback(async () => {
    await syncNow('user_waypoints')
    await refresh()
  }, [refresh])

  const saveWaypoint = useCallback(async (doc: UserWaypointDocType) => {
    await waypointsDb.upsert(doc)
    await refresh()
    notifyLocalChange('user_waypoints')
  }, [refresh])

  const deleteWaypoint = useCallback(async (id: string) => {
    await waypointsDb.delete(id)
    await refresh()
    await notifyLocalDelete('user_waypoints', id)
  }, [refresh])

  return { syncState: status, waypoints, pull, saveWaypoint, deleteWaypoint }
}
