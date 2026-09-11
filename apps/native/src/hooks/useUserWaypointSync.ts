/**
 * useUserWaypointSync — two-way sync between AsyncStorage (local) and PostgREST
 * (cloud) for user-saved waypoints.
 *
 * Mirrors useRouteSync.ts / useAircraftSync.ts. PostgREST table: user_waypoints
 *   id, user_id, name, lng, lat, folder, updated_at
 *
 * Native has no per-field updatedAt-authoritative id scheme conflict (unlike
 * settings' user_id+key), so plain id on_conflict works here, same as routes.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { waypoints as waypointsDb } from '../db'
import type { UserWaypointDocType } from '../types/db'
import { API_BASE } from '../config'
import { authHeaders } from '../utils/authClient'
import { useAuthContext } from '../context/AuthContext'
import { getLastSyncAt, setLastSyncAt } from './syncMeta'

const REST = `${API_BASE}/rest`

interface ServerWaypoint {
  id:         string
  name:       string
  lng:        number
  lat:        number
  folder:     string
  updated_at: string
}

let _jwt:       string | null = null
let _jwtExpiry: number        = 0

async function getJwt(): Promise<string | null> {
  if (_jwt && Date.now() < _jwtExpiry) return _jwt
  try {
    // Authorization header required -- see useRouteSync.ts's getJwt() for
    // the full explanation (this endpoint 401s without it, always, since RN
    // has no cookie jar to carry a session implicitly).
    const res = await fetch(`${API_BASE}/api/auth/token`, {
      headers: { Origin: API_BASE, ...(await authHeaders()) },
    })
    if (!res.ok) return null
    const body = await res.json() as { jwt: string; expiresAt: number }
    _jwt       = body.jwt
    _jwtExpiry = (body.expiresAt - 60) * 1000
    return _jwt
  } catch {
    return null
  }
}

async function restFetch(jwt: string): Promise<ServerWaypoint[]> {
  const res = await fetch(`${REST}/user_waypoints?select=*&order=updated_at.desc`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
  })
  if (!res.ok) return []
  return res.json() as Promise<ServerWaypoint[]>
}

// PostgREST is the timestamp source of truth for cross-device merge decisions;
// UserWaypointDocType.updatedAt is set locally on every save/pull.
// user_id is required — the table's RLS WITH CHECK (auth_user_id() = user_id)
// rejects (silently, since we swallow errors) any insert missing it, and the
// column itself is NOT NULL with no default, so omitting it always 400s.
async function restUpsert(jwt: string, userId: string, doc: UserWaypointDocType): Promise<void> {
  const res = await fetch(`${REST}/user_waypoints?on_conflict=id`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      id:         doc.id,
      user_id:    userId,
      name:       doc.name,
      lng:        doc.lng,
      lat:        doc.lat,
      folder:     doc.folder,
      updated_at: new Date(doc.updatedAt).toISOString(),
    }),
  })
  if (!res.ok) console.warn('[useUserWaypointSync] restUpsert failed', res.status, await res.text().catch(() => ''))
}

async function restDelete(jwt: string, id: string): Promise<void> {
  await fetch(`${REST}/user_waypoints?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export function useUserWaypointSync(authenticated: boolean) {
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [waypoints, setWaypoints] = useState<UserWaypointDocType[]>([])
  const syncedRef = useRef(false)
  const { state: authState } = useAuthContext()
  const userId = authState.status === 'authenticated' ? authState.user.id : null

  const refresh = useCallback(async () => {
    setWaypoints(await waypointsDb.getAll())
  }, [])

  const pull = useCallback(async () => {
    setSyncState('syncing')
    const jwt = await getJwt()
    if (!jwt) { setSyncState('offline'); await refresh(); return }

    try {
      const serverWps = await restFetch(jwt)
      const localWps  = await waypointsDb.getAll()
      const lastSyncAt = await getLastSyncAt()
      const serverIds  = new Set(serverWps.map(sw => sw.id))

      for (const sw of serverWps) {
        const serverTs = new Date(sw.updated_at).getTime()
        const local = localWps.find(w => w.id === sw.id)
        if (!local || local.updatedAt < serverTs) {
          await waypointsDb.upsert({
            id:        sw.id,
            name:      sw.name,
            lng:       sw.lng,
            lat:       sw.lat,
            folder:    sw.folder ?? '',
            updatedAt: serverTs,
          })
        }
      }

      // Reconcile local rows the server doesn't have: push genuinely new/
      // offline ones, but delete locally (don't resurrect) ones unmodified
      // since our last successful sync — those were deleted on another device.
      for (const local of localWps) {
        if (serverIds.has(local.id)) continue
        if (lastSyncAt > 0 && local.updatedAt <= lastSyncAt) {
          await waypointsDb.delete(local.id)
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

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!authenticated || syncedRef.current) return
    syncedRef.current = true
    pull()
  }, [authenticated, pull])

  const saveWaypoint = useCallback(async (doc: UserWaypointDocType) => {
    await waypointsDb.upsert(doc)
    await refresh()
    if (!authenticated || !userId) return
    const jwt = await getJwt()
    if (!jwt) return
    try { await restUpsert(jwt, userId, doc) } catch { /* offline-safe */ }
  }, [authenticated, refresh, userId])

  const deleteWaypoint = useCallback(async (id: string) => {
    await waypointsDb.delete(id)
    await refresh()
    if (!authenticated) return
    const jwt = await getJwt()
    if (!jwt) return
    try { await restDelete(jwt, id) } catch { /* offline-safe */ }
  }, [authenticated, refresh])

  return { syncState, waypoints, pull, saveWaypoint, deleteWaypoint }
}
