/**
 * useAircraftSync — aircraft profiles (local AsyncStorage) with cloud sync.
 *
 * The sync itself (two-way, offline-safe, deletes included) runs in
 * ../sync/cloudSync.ts; this hook keeps the local list for the UI and
 * reports local edits to it.
 */

import { useState, useEffect, useCallback } from 'react'
import { aircraft as aircraftDb } from '../db'
import type { AircraftProfileDocType } from '../types/db'
import { notifyLocalChange, notifyLocalDelete, syncNow, useTableSync } from '../sync/cloudSync'
export function useAircraftSync() {
  const { status, localVersion } = useTableSync('user_aircraft_profiles')
  const [profiles, setProfiles] = useState<AircraftProfileDocType[]>([])

  const refresh = useCallback(async () => {
    setProfiles(await aircraftDb.getAll())
  }, [])

  // Load immediately (works offline / signed out) and after a sync round
  // changed local rows.
  useEffect(() => { void refresh() }, [refresh, localVersion])

  const pull = useCallback(async () => {
    await syncNow('user_aircraft_profiles')
    await refresh()
  }, [refresh])

  const pushAircraft = useCallback(async (doc: AircraftProfileDocType) => {
    await aircraftDb.upsert(doc)
    await refresh()
    notifyLocalChange('user_aircraft_profiles')
  }, [refresh])

  const deleteAircraft = useCallback(async (id: string) => {
    await aircraftDb.delete(id)
    await refresh()
    await notifyLocalDelete('user_aircraft_profiles', id)
  }, [refresh])

  return { syncState: status, profiles, pull, pushAircraft, deleteAircraft }
}
