/**
 * useRouteSync — two-way sync between AsyncStorage (local) and PostgREST (cloud).
 *
 * Mirrors the web's useSync.ts but for native AsyncStorage instead of RxDB.
 *
 * Strategy (matches web):
 *   1. Pull: fetch all user_routes from PostgREST → merge into AsyncStorage
 *      (server wins on first login; most-recent updatedAt wins on conflict)
 *   2. Push: after every local route change (save/rename/delete), upsert PostgREST
 *
 * JWT:  GET /api/auth/token (our Hono endpoint) returns a short-lived PostgREST
 *       JWT signed with BETTER_AUTH_SECRET. Fetched via the shared, cached
 *       getSyncJwt() (see ../utils/syncJwt.ts) -- shared across all sync
 *       hooks, with a session-refresh retry baked in (see that file's doc
 *       comment for the silent-failure bug this fixes).
 *
 * PostgREST table: user_routes
 *   id, user_id, name, waypoints (jsonb), leg_overrides (jsonb), updated_at
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { AppState } from 'react-native'
import { routes as routeDb } from '../db'
import type { RouteDocType } from '../types/db'
import { API_BASE } from '../config'
import { getSyncJwt } from '../utils/syncJwt'
import { useAuthContext } from '../context/AuthContext'
import { getLastSyncAt, setLastSyncAt } from './syncMeta'

// ── PostgREST helpers ─────────────────────────────────────────────────────────

const REST = `${API_BASE}/rest`

interface ServerRoute {
  id:            string
  name:          string
  waypoints:     unknown
  leg_overrides: unknown
  aircraft_id:   string
  updated_at:    string
}

// JWT fetching moved to ../utils/syncJwt.ts (getSyncJwt) — shared across all sync hooks.

async function restFetch(jwt: string): Promise<ServerRoute[]> {
  const res = await fetch(`${REST}/user_routes?select=*&order=updated_at.desc`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
  })
  if (!res.ok) return []
  return res.json() as Promise<ServerRoute[]>
}

// user_id is required — RLS WITH CHECK (auth_user_id() = user_id) plus the
// NOT NULL column with no default reject any insert missing it.
async function restUpsert(jwt: string, userId: string, route: RouteDocType): Promise<boolean> {
  const res = await fetch(`${REST}/user_routes?on_conflict=id`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      id:           route.id,
      user_id:      userId,
      name:         route.name,
      waypoints:    route.waypoints,
      leg_overrides: route.legOverrides,
      aircraft_id:  route.aircraftId ?? '',
      updated_at:   new Date(route.updatedAt).toISOString(),
    }),
  })
  if (!res.ok) {
    console.warn('[useRouteSync] restUpsert failed', res.status, await res.text().catch(() => ''))
    return false
  }
  return true
}

async function restDelete(jwt: string, id: string): Promise<boolean> {
  const res = await fetch(`${REST}/user_routes?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    console.warn('[useRouteSync] restDelete failed', res.status, await res.text().catch(() => ''))
    return false
  }
  return true
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export function useRouteSync(authenticated: boolean) {
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const syncedRef = useRef(false)
  const { state: authState } = useAuthContext()
  const userId = authState.status === 'authenticated' ? authState.user.id : null

  // Exposed so callers (e.g. pull-to-refresh in RouteLibrarySheet) can trigger
  // an on-demand re-pull, not just the once-per-login automatic one below —
  // picks up routes added/edited on another device or the web app while this
  // session is already running.
  const pull = useCallback(async () => {
    if (!authenticated) return
    setSyncState('syncing')
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('offline'); return }

    try {
      const serverRoutes = await restFetch(jwt)
      const localRoutes  = await routeDb.getAll()
      const lastSyncAt   = await getLastSyncAt()
      const serverIds    = new Set(serverRoutes.map(sr => sr.id))

      for (const sr of serverRoutes) {
        const serverUpdated = new Date(sr.updated_at).getTime()
        const local = localRoutes.find(r => r.id === sr.id)
        if (!local || local.updatedAt < serverUpdated) {
          await routeDb.upsert({
            id:           sr.id,
            name:         sr.name,
            waypoints:    (typeof sr.waypoints    === 'string' ? JSON.parse(sr.waypoints)    : sr.waypoints)    ?? [],
            legOverrides: (typeof sr.leg_overrides === 'string' ? JSON.parse(sr.leg_overrides) : sr.leg_overrides) ?? [],
            aircraftId:   sr.aircraft_id ?? '',
            updatedAt:    serverUpdated,
          })
        }
      }

      // Reconcile local rows the server doesn't have: push genuinely new/
      // offline-created ones, but delete locally (don't resurrect) ones that
      // are unmodified since our last successful sync — those were deleted on
      // another device.
      for (const local of localRoutes) {
        if (local.id === 'current') continue  // active route managed separately
        if (serverIds.has(local.id)) continue
        if (lastSyncAt > 0 && local.updatedAt <= lastSyncAt) {
          await routeDb.delete(local.id)
          continue
        }
        if (userId) await restUpsert(jwt, userId, local)
      }

      await setLastSyncAt(Date.now())
      setSyncState('idle')
    } catch {
      setSyncState('error')
    }
  }, [authenticated, userId])

  // Initial pull on login
  useEffect(() => {
    if (!authenticated || syncedRef.current) return
    syncedRef.current = true
    pull()
  }, [authenticated, pull])

  // Re-pull whenever the app returns to the foreground. The native app
  // process stays alive across app-switches (unlike the web PWA, which
  // naturally re-runs useSync's pull on every page reload) — without this,
  // a route saved/edited on another device or the web app never appears
  // here until the user force-quits and relaunches, or manually pulls to
  // refresh in the Route Library sheet. This is the fix for routes edited
  // elsewhere silently failing to show up while the app stays backgrounded.
  useEffect(() => {
    if (!authenticated) return
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void pull()
    })
    return () => sub.remove()
  }, [authenticated, pull])

  const pushRoute = useCallback(async (route: RouteDocType) => {
    if (!authenticated || !userId) return
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('error'); return }
    try {
      const ok = await restUpsert(jwt, userId, route)
      setSyncState(ok ? 'idle' : 'error')
    } catch {
      setSyncState('offline')  // network-level failure, not an auth/server error
    }
  }, [authenticated, userId])

  const deleteRoute = useCallback(async (id: string) => {
    if (!authenticated) return
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('error'); return }
    try {
      const ok = await restDelete(jwt, id)
      setSyncState(ok ? 'idle' : 'error')
    } catch {
      setSyncState('offline')
    }
  }, [authenticated])

  return { syncState, pull, pushRoute, deleteRoute }
}
