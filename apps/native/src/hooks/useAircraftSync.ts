/**
 * useAircraftSync — two-way sync between AsyncStorage (local) and PostgREST (cloud)
 * for aircraft profiles.
 *
 * Mirrors useRouteSync.ts (native routes) / web's useSync.ts (aircraft_profiles).
 *
 * Strategy:
 *   1. Pull: fetch all user_aircraft_profiles from PostgREST → merge into
 *      AsyncStorage (most-recent updatedAt wins).
 *   2. Push: after every local aircraft profile change (save/delete), upsert PostgREST.
 *
 * JWT:  GET /api/auth/token (our Hono endpoint) returns a short-lived PostgREST
 *       JWT signed with BETTER_AUTH_SECRET. Cached for 55 min (shared cache w/ useRouteSync
 *       would be nicer, but duplicated here to keep hooks independent).
 *
 * PostgREST table: user_aircraft_profiles
 *   id, user_id, data (jsonb — full AircraftProfileDocType), updated_at
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { aircraft as aircraftDb } from '../db'
import type { AircraftProfileDocType } from '../types/db'
import { API_BASE } from '../config'
import { getSyncJwt } from '../utils/syncJwt'
import { useAuthContext } from '../context/AuthContext'
import { getLastSyncAt, setLastSyncAt } from './syncMeta'

const REST = `${API_BASE}/rest`

interface ServerAircraft {
  id:         string
  data:       unknown
  updated_at: string
}

// JWT fetching moved to ../utils/syncJwt.ts (getSyncJwt) — shared across all sync hooks.

async function restFetch(jwt: string): Promise<ServerAircraft[]> {
  const res = await fetch(`${REST}/user_aircraft_profiles?select=*&order=updated_at.desc`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    console.warn('[useAircraftSync] restFetch failed', res.status, await res.text().catch(() => ''))
    return []
  }
  return res.json() as Promise<ServerAircraft[]>
}

// user_id is required — RLS WITH CHECK (auth_user_id() = user_id) plus the
// NOT NULL column with no default reject any insert missing it.
async function restUpsert(jwt: string, userId: string, doc: AircraftProfileDocType): Promise<boolean> {
  const res = await fetch(`${REST}/user_aircraft_profiles?on_conflict=id`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      id:         doc.id,
      user_id:    userId,
      data:       doc,
      updated_at: new Date(doc.updatedAt).toISOString(),
    }),
  })
  if (!res.ok) {
    console.warn('[useAircraftSync] restUpsert failed', res.status, await res.text().catch(() => ''))
    return false
  }
  return true
}

async function restDelete(jwt: string, id: string): Promise<boolean> {
  const res = await fetch(`${REST}/user_aircraft_profiles?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    console.warn('[useAircraftSync] restDelete failed', res.status, await res.text().catch(() => ''))
    return false
  }
  return true
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export function useAircraftSync(authenticated: boolean) {
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [profiles, setProfiles]   = useState<AircraftProfileDocType[]>([])
  const syncedRef = useRef(false)
  const { state: authState } = useAuthContext()
  const userId = authState.status === 'authenticated' ? authState.user.id : null

  const refresh = useCallback(async () => {
    setProfiles(await aircraftDb.getAll())
  }, [])

  const pull = useCallback(async () => {
    setSyncState('syncing')
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('offline'); await refresh(); return }

    try {
      const serverAircraft = await restFetch(jwt)
      console.log('[useAircraftSync] pull: server has', serverAircraft.length, 'profiles')
      const localAircraft  = await aircraftDb.getAll()
      const lastSyncAt     = await getLastSyncAt()
      const serverIds      = new Set(serverAircraft.map(sa => sa.id))

      for (const sa of serverAircraft) {
        const serverTs = new Date(sa.updated_at).getTime()
        const data = (typeof sa.data === 'string' ? JSON.parse(sa.data) : sa.data) as AircraftProfileDocType
        const local = localAircraft.find(a => a.id === sa.id)
        if (!local || local.updatedAt < serverTs) {
          await aircraftDb.upsert({ ...data, id: sa.id, updatedAt: serverTs })
        }
      }

      // Reconcile local rows the server doesn't have: push genuinely new/
      // offline ones, but delete locally (don't resurrect) ones unmodified
      // since our last successful sync — those were deleted on another device.
      for (const local of localAircraft) {
        if (serverIds.has(local.id)) continue
        if (lastSyncAt > 0 && local.updatedAt <= lastSyncAt) {
          await aircraftDb.delete(local.id)
          continue
        }
        if (userId) await restUpsert(jwt, userId, local)
      }

      await setLastSyncAt(Date.now())
      setSyncState('idle')
    } catch {
      setSyncState('error')
    }
    await refresh()
  }, [refresh, userId])

  // Load local profiles immediately (works offline / logged-out).
  useEffect(() => { refresh() }, [refresh])

  // Pull from cloud once per login.
  useEffect(() => {
    if (!authenticated || syncedRef.current) return
    syncedRef.current = true
    pull()
  }, [authenticated, pull])

  const pushAircraft = useCallback(async (doc: AircraftProfileDocType) => {
    await aircraftDb.upsert(doc)
    await refresh()
    if (!authenticated || !userId) return
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('error'); return }
    try {
      const ok = await restUpsert(jwt, userId, doc)
      setSyncState(ok ? 'idle' : 'error')
    } catch {
      setSyncState('offline')
    }
  }, [authenticated, refresh, userId])

  const deleteAircraft = useCallback(async (id: string) => {
    await aircraftDb.delete(id)
    await refresh()
    if (!authenticated) return
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('error'); return }
    try {
      const ok = await restDelete(jwt, id)
      setSyncState(ok ? 'idle' : 'error')
    } catch {
      setSyncState('offline')
    }
  }, [authenticated, refresh])

  return { syncState, profiles, pull, pushAircraft, deleteAircraft }
}
