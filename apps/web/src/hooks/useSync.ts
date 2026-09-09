/**
 * useSync — two-way sync between RxDB (local) and PostgREST (cloud).
 *
 * Called once after login. Strategy:
 *   1. Pull: fetch all user rows from PostgREST → merge into RxDB (server wins
 *      on first login; local wins mid-session for more recent rows).
 *   2. Initial push: bulk-upsert all existing local documents so data created
 *      before login (e.g. flight logs recorded without an account) is uploaded.
 *   3. Push: subscribe to RxDB changestream → upsert PostgREST on each change.
 *
 * Collections synced:
 *   routes, aircraft_profiles, user_waypoints, settings, flight_logs → two-way
 *   flight_logs: no UPDATE grant (a completed log is never edited after the
 *   fact) but DELETE is supported (pilot removes a log from their history) —
 *   INSERT uses ignore-duplicates so a re-push of the same id is a safe no-op
 *
 * PostgREST requests use `Authorization: Bearer <jwt>` from useAuth.
 */

import { useEffect, useRef } from 'react'
import type { AuthState } from './useAuth'
import { getDb } from '../db'
import { API_BASE_URL } from '../utils/env'
import type {
  RouteDocType,
  AircraftProfileDocType,
  UserWaypointDocType,
  SettingsDocType,
  FlightLogDocType,
} from '../db'

// ---------------------------------------------------------------------------
// PostgREST base URL (served at /rest/ via nginx)
// ---------------------------------------------------------------------------
const REST = `${API_BASE_URL}/rest`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * POST a row to PostgREST.
 * prefer controls ON CONFLICT behaviour:
 *   'resolution=merge-duplicates' (default) → ON CONFLICT DO UPDATE (needs UPDATE grant)
 *   'resolution=ignore-duplicates'           → ON CONFLICT DO NOTHING  (INSERT-only tables)
 */
async function restUpsert(
  jwt: string,
  table: string,
  row: Record<string, unknown>,
  onConflict?: string,
  prefer = 'resolution=merge-duplicates',
): Promise<void> {
  const url = onConflict
    ? `${REST}/${table}?on_conflict=${encodeURIComponent(onConflict)}`
    : `${REST}/${table}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.warn(`[useSync] upsert ${table} failed ${res.status}:`, text)
  }
}

/** DELETE a row from a PostgREST table, filtered by an arbitrary column (defaults to 'id'). */
async function restDelete(jwt: string, table: string, value: string, column = 'id'): Promise<void> {
  const res = await fetch(`${REST}/${table}?${column}=eq.${encodeURIComponent(value)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.warn(`[useSync] delete ${table} failed ${res.status}:`, text)
  }
}

// ---------------------------------------------------------------------------
// Cross-device delete reconciliation
// ---------------------------------------------------------------------------
// Problem this solves: Device A deletes a waypoint and pushes DELETE to the
// server. Device B still has its own local (undeleted) copy from before that
// change ever reached it. When Device B's sync next runs, its "push anything
// local the server doesn't have" step sees the row is missing server-side and
// — with no way to tell "deleted elsewhere" apart from "never uploaded yet" —
// re-uploads it, resurrecting it everywhere on the next pull. This is exactly
// how a delete on one device/browser tab "undoes itself" after a refresh.
//
// Fix: track the timestamp of this device's last successful sync round in
// localStorage (deliberately NOT synced itself — a per-device high-water
// mark). When a local doc is missing from the server response:
//   - lastSyncAt === 0 (first sync ever)        → genuinely new, push it.
//   - doc.updatedAt <= lastSyncAt                → unmodified since our last
//     successful sync, so its absence means it was deleted elsewhere — remove
//     it locally instead of resurrecting it.
//   - doc.updatedAt >  lastSyncAt                → edited/created locally
//     since our last sync (e.g. offline) — push it.
const LAST_SYNC_KEY = 'openvfr.sync.lastSyncAt'
function getLastSyncAt(): number {
  return Number(localStorage.getItem(LAST_SYNC_KEY) ?? '0')
}
function setLastSyncAt(ts: number): void {
  localStorage.setItem(LAST_SYNC_KEY, String(ts))
}

/** Fetch all rows for the current user from a PostgREST table. */
async function restFetch<T>(jwt: string, table: string): Promise<T[]> {
  const res = await fetch(`${REST}/${table}?select=*`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    console.warn(`[useSync] fetch ${table} failed ${res.status}`)
    return []
  }
  return res.json() as Promise<T[]>
}

// ---------------------------------------------------------------------------
// Map server row shapes ↔ RxDB doctype shapes
// ---------------------------------------------------------------------------

interface ServerRoute {
  id:            string
  user_id:       string
  name:          string
  waypoints:     unknown
  leg_overrides: unknown
  aircraft_id:   string
  updated_at:    string
}

interface ServerAircraft {
  id:         string
  user_id:    string
  data:       unknown
  updated_at: string
}

interface ServerWaypoint {
  id:         string
  user_id:    string
  name:       string
  lng:        number
  lat:        number
  folder:     string
  updated_at: string
}

interface ServerSetting {
  id:         string
  user_id:    string
  key:        string
  value:      string
  updated_at: string
}

interface ServerFlightLog {
  id:             string
  user_id:        string
  started_at:     string | null
  ended_at:       string | null
  aircraft_id:    string
  registration:   string
  track_json:     string
  departure_icao: string
  arrival_icao:   string
  distance_nm:    number | null
  max_alt_ft:     number | null
  updated_at:     string
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useSync(auth: AuthState): void {
  // Prevent double-subscriptions on React strict-mode double-mount.
  const syncedRef  = useRef(false)
  const jwt        = auth.jwt
  const userId     = auth.user?.id

  // Re-pull routes whenever the tab regains focus/visibility. A long-lived
  // installed PWA session (or just a tab left open for hours) never re-runs
  // the one-time login pull below, so a route saved/edited on another device
  // or the native app never appears here until a manual page reload. Mirrors
  // native's AppState-foreground re-pull in useRouteSync.ts — idempotent:
  // re-upserting an already-current doc is a harmless no-op, and if it
  // brings in a genuinely newer server row, the existing changestream
  // subscription below just re-pushes the identical row back (safe).
  useEffect(() => {
    if (!jwt || !userId) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void (async () => {
        try {
          const db = await getDb()
          const serverRoutes = await restFetch<ServerRoute>(jwt, 'user_routes')
          for (const r of serverRoutes) {
            const existing = await db.routes.findOne(r.id).exec()
            const serverTs = new Date(r.updated_at).getTime()
            if (!existing || existing.updatedAt < serverTs) {
              await db.routes.upsert({
                id:           r.id,
                name:         r.name,
                waypoints:    (typeof r.waypoints === 'string' ? JSON.parse(r.waypoints) : r.waypoints) as RouteDocType['waypoints'],
                legOverrides: (typeof r.leg_overrides === 'string' ? JSON.parse(r.leg_overrides) : r.leg_overrides ?? []) as RouteDocType['legOverrides'],
                aircraftId:   r.aircraft_id ?? '',
                updatedAt:    serverTs,
              })
            }
          }
        } catch (e) { console.warn('[useSync] visibility re-pull error:', e) }
      })()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [jwt, userId])

  useEffect(() => {
    if (!jwt || !userId) return
    if (syncedRef.current) return
    syncedRef.current = true

    let cancelled = false

    const run = async () => {
      const db = await getDb()

      // ── Pull phase ─────────────────────────────────────────────────────

      // Routes
      const serverRoutes = await restFetch<ServerRoute>(jwt, 'user_routes')
      for (const r of serverRoutes) {
        if (cancelled) return
        try {
          const existing = await db.routes.findOne(r.id).exec()
          const serverTs = new Date(r.updated_at).getTime()
          if (!existing || existing.updatedAt < serverTs) {
            await db.routes.upsert({
              id:           r.id,
              name:         r.name,
              waypoints:    (typeof r.waypoints === 'string' ? JSON.parse(r.waypoints) : r.waypoints) as RouteDocType['waypoints'],
              legOverrides: (typeof r.leg_overrides === 'string' ? JSON.parse(r.leg_overrides) : r.leg_overrides ?? []) as RouteDocType['legOverrides'],
              aircraftId:   r.aircraft_id ?? '',
              updatedAt:    serverTs,
            })
          }
        } catch (e) { console.warn('[useSync] route pull error:', e) }
      }

      // Aircraft profiles
      const serverAircraft = await restFetch<ServerAircraft>(jwt, 'user_aircraft_profiles')
      for (const a of serverAircraft) {
        if (cancelled) return
        try {
          const data = (typeof a.data === 'string' ? JSON.parse(a.data) : a.data) as AircraftProfileDocType
          const existing = await db.aircraft_profiles.findOne(a.id).exec()
          const serverTs = new Date(a.updated_at).getTime()
          if (!existing || existing.updatedAt < serverTs) {
            await db.aircraft_profiles.upsert({ ...data, id: a.id, updatedAt: serverTs })
          }
        } catch (e) { console.warn('[useSync] aircraft pull error:', e) }
      }

      // User waypoints
      const serverWps = await restFetch<ServerWaypoint>(jwt, 'user_waypoints')
      for (const w of serverWps) {
        if (cancelled) return
        try {
          const existing = await db.user_waypoints.findOne(w.id).exec()
          const serverTs = new Date(w.updated_at).getTime()
          if (!existing || existing.updatedAt < serverTs) {
            await db.user_waypoints.upsert({
              id:        w.id,
              name:      w.name,
              lng:       w.lng,
              lat:       w.lat,
              folder:    w.folder,
              updatedAt: serverTs,
            } as UserWaypointDocType)
          }
        } catch (e) { console.warn('[useSync] waypoint pull error:', e) }
      }

      // Settings
      const serverSettings = await restFetch<ServerSetting>(jwt, 'user_settings')
      for (const s of serverSettings) {
        if (cancelled) return
        try {
          // Server id is a UUID; local id is the key string — match by key.
          const existing = await db.settings.findOne(s.key).exec()
          if (!existing || existing.value !== s.value) {
            await db.settings.upsert({ id: s.key, value: s.value })
          }
        } catch (e) { console.warn('[useSync] settings pull error:', e) }
      }

      // Flight logs — pull completed logs from all user devices into local RxDB so the
      // Flight Logs panel shows the full cross-device history everywhere.
      const serverLogs = await restFetch<ServerFlightLog>(jwt, 'user_flight_logs')
      for (const log of serverLogs) {
        if (cancelled) return
        // Only import completed logs (endedAt is set).
        if (!log.ended_at) continue
        try {
          const existing  = await db.flight_logs.findOne(log.id).exec()
          const serverTs  = new Date(log.updated_at).getTime()
          if (!existing || existing.updatedAt < serverTs) {
            await db.flight_logs.upsert({
              id:            log.id,
              startedAt:     log.started_at ? new Date(log.started_at).getTime() : 0,
              endedAt:       log.ended_at   ? new Date(log.ended_at).getTime()   : 0,
              aircraftId:    log.aircraft_id    ?? '',
              registration:  log.registration   ?? '',
              trackJson:     log.track_json      ?? '[]',
              departureIcao: log.departure_icao  ?? '',
              arrivalIcao:   log.arrival_icao    ?? '',
              distanceNm:    log.distance_nm     ?? 0,
              maxAltFt:      log.max_alt_ft      ?? 0,
              updatedAt:     serverTs,
            })
          }
        } catch (e) { console.warn('[useSync] flight log pull error:', e) }
      }

      if (cancelled) return

      // ── Initial push phase — upload pre-existing local data ───────────
      // Handles data created before the user logged in (e.g. flight logs
      // recorded anonymously). The changestream below only catches future
      // writes, so we must explicitly push the current snapshot on first sync.

      const [localRoutes, localAircraft, localWaypoints, localSettings, localLogs] =
        await Promise.all([
          db.routes.find().exec(),
          db.aircraft_profiles.find().exec(),
          db.user_waypoints.find().exec(),
          db.settings.find().exec(),
          db.flight_logs.find({ selector: { endedAt: { $gt: 0 } } }).exec(),
        ])
      if (cancelled) return

      const lastSyncAt = getLastSyncAt()
      const serverRouteIds     = new Set(serverRoutes.map(r => r.id))
      const serverAircraftIds  = new Set(serverAircraft.map(a => a.id))
      const serverWaypointIds  = new Set(serverWps.map(w => w.id))

      for (const doc of localRoutes) {
        // Skip 'current' — it's the live working route (not a saved named route)
        // and its ID is not a valid UUID, which PostgreSQL would reject.
        if (doc.id === 'current') continue
        if (serverRouteIds.has(doc.id)) continue
        if (lastSyncAt > 0 && doc.updatedAt <= lastSyncAt) {
          // Missing server-side and unmodified since our last sync — deleted
          // on another device. Remove locally instead of resurrecting it.
          await doc.remove()
          continue
        }
        void restUpsert(jwt, 'user_routes', {
          id:            doc.id,
          user_id:       userId,
          name:          doc.name,
          waypoints:     doc.waypoints,
          leg_overrides: doc.legOverrides,
          aircraft_id:   doc.aircraftId ?? '',
          updated_at:    new Date(doc.updatedAt).toISOString(),
        })
      }
      for (const doc of localAircraft) {
        if (serverAircraftIds.has(doc.id)) continue
        if (lastSyncAt > 0 && doc.updatedAt <= lastSyncAt) {
          await doc.remove()
          continue
        }
        const d = doc.toJSON() as AircraftProfileDocType
        void restUpsert(jwt, 'user_aircraft_profiles', {
          id:         d.id,
          user_id:    userId,
          data:       d,
          updated_at: new Date(d.updatedAt).toISOString(),
        })
      }
      for (const doc of localWaypoints) {
        if (serverWaypointIds.has(doc.id)) continue
        if (lastSyncAt > 0 && doc.updatedAt <= lastSyncAt) {
          await doc.remove()
          continue
        }
        void restUpsert(jwt, 'user_waypoints', {
          id:         doc.id,
          user_id:    userId,
          name:       doc.name,
          lng:        doc.lng,
          lat:        doc.lat,
          folder:     doc.folder,
          updated_at: new Date(doc.updatedAt).toISOString(),
        })
      }
      for (const doc of localSettings) {
        // Use on_conflict=user_id,key — the natural unique key — so PostgREST
        // generates ON CONFLICT (user_id, key) DO UPDATE. This handles rows
        // that were previously inserted with random UUIDs (before the
        // deterministic settingsRowId was introduced) without 409ing.
        void restUpsert(jwt, 'user_settings', {
          user_id:    userId,
          key:        doc.id,
          value:      doc.value,
          updated_at: new Date().toISOString(),
        }, 'user_id,key')
      }
      // Only push logs the server doesn't already have — serverLogs was fetched
      // in the pull phase above. Avoids a redundant POST per completed log on
      // every login; ignore-duplicates made this safe but wasteful before.
      // Mirrors native's useFlightLogSync.ts (which does the same check).
      for (const doc of localLogs) {
        if (serverLogs.some(sl => sl.id === doc.id)) continue
        if (lastSyncAt > 0 && doc.updatedAt <= lastSyncAt) {
          // Missing server-side and unmodified since our last sync — deleted
          // (this device or another) — remove locally instead of resurrecting.
          await doc.remove()
          continue
        }
        void restUpsert(jwt, 'user_flight_logs', {
          id:             doc.id,
          user_id:        userId,
          started_at:     doc.startedAt ? new Date(doc.startedAt).toISOString() : null,
          ended_at:       doc.endedAt   ? new Date(doc.endedAt).toISOString()   : null,
          aircraft_id:    doc.aircraftId    ?? '',
          registration:   doc.registration  ?? '',
          track_json:     doc.trackJson     ?? '[]',
          departure_icao: doc.departureIcao ?? '',
          arrival_icao:   doc.arrivalIcao   ?? '',
          distance_nm:    doc.distanceNm    ?? null,
          max_alt_ft:     doc.maxAltFt      ?? null,
          updated_at:     new Date(doc.updatedAt).toISOString(),
        }, undefined, 'resolution=ignore-duplicates')
      }

      if (cancelled) return

      // Stamp this device's high-water mark now that the pull + reconcile
      // round has fully completed — used by the next sync round to tell
      // "deleted elsewhere" apart from "never uploaded yet".
      setLastSyncAt(Date.now())

      // ── Push phase — subscribe to local changes ────────────────────────
      const subs: Array<{ unsubscribe(): void }> = []

      // Routes
      subs.push(
        db.routes.$.subscribe((changeEvent) => {
          const doc = changeEvent.documentData as RouteDocType
          if (doc.id === 'current') return  // skip live working route
          if (changeEvent.operation === 'DELETE') {
            void restDelete(jwt, 'user_routes', doc.id)
            return
          }
          void restUpsert(jwt, 'user_routes', {
            id:            doc.id,
            user_id:       userId,
            name:          doc.name,
            waypoints:     doc.waypoints,
            leg_overrides: doc.legOverrides,
            aircraft_id:   doc.aircraftId ?? '',
            updated_at:    new Date(doc.updatedAt).toISOString(),
          })
        })
      )

      // Aircraft profiles
      subs.push(
        db.aircraft_profiles.$.subscribe((changeEvent) => {
          const doc = changeEvent.documentData as AircraftProfileDocType
          if (changeEvent.operation === 'DELETE') {
            void restDelete(jwt, 'user_aircraft_profiles', doc.id)
            return
          }
          void restUpsert(jwt, 'user_aircraft_profiles', {
            id:         doc.id,
            user_id:    userId,
            data:       doc,
            updated_at: new Date(doc.updatedAt).toISOString(),
          })
        })
      )

      // User waypoints
      subs.push(
        db.user_waypoints.$.subscribe((changeEvent) => {
          const doc = changeEvent.documentData as UserWaypointDocType
          if (changeEvent.operation === 'DELETE') {
            void restDelete(jwt, 'user_waypoints', doc.id)
            return
          }
          void restUpsert(jwt, 'user_waypoints', {
            id:         doc.id,
            user_id:    userId,
            name:       doc.name,
            lng:        doc.lng,
            lat:        doc.lat,
            folder:     doc.folder,
            updated_at: new Date(doc.updatedAt).toISOString(),
          })
        })
      )

      // Settings
      subs.push(
        db.settings.$.subscribe((changeEvent) => {
          const doc = changeEvent.documentData as SettingsDocType
          if (changeEvent.operation === 'DELETE') {
            void restDelete(jwt, 'user_settings', doc.id, 'key')
            return
          }
          void restUpsert(jwt, 'user_settings', {
            user_id:    userId,
            key:        doc.id,
            value:      doc.value,
            updated_at: new Date().toISOString(),
          }, 'user_id,key')
        })
      )

      // Flight logs — INSERT-only (no UPDATE grant, completed logs are never
      // edited) but DELETE-capable (pilot removes a log from their history).
      // Only push completed logs (endedAt > 0) so the server never receives the
      // in-progress skeleton. Use ignore-duplicates so a re-push of the same
      // log ID (e.g. logging in again on the same device) is a safe no-op.
      subs.push(
        db.flight_logs.$.subscribe((changeEvent) => {
          if (changeEvent.operation === 'DELETE') {
            const deletedId = (changeEvent.documentData as FlightLogDocType).id
            void restDelete(jwt, 'user_flight_logs', deletedId)
            return
          }
          const doc = changeEvent.documentData as FlightLogDocType
          if (doc.endedAt === 0) return  // skip in-progress skeleton
          void restUpsert(jwt, 'user_flight_logs', {
            id:             doc.id,
            user_id:        userId,
            started_at:     doc.startedAt ? new Date(doc.startedAt).toISOString() : null,
            ended_at:       doc.endedAt   ? new Date(doc.endedAt).toISOString()   : null,
            aircraft_id:    doc.aircraftId    ?? '',
            registration:   doc.registration  ?? '',
            track_json:     doc.trackJson     ?? '[]',
            departure_icao: doc.departureIcao ?? '',
            arrival_icao:   doc.arrivalIcao   ?? '',
            distance_nm:    doc.distanceNm    ?? null,
            max_alt_ft:     doc.maxAltFt      ?? null,
            updated_at:     new Date(doc.updatedAt).toISOString(),
          }, undefined, 'resolution=ignore-duplicates')
        })
      )

      // Cleanup when the effect tears down (logout / unmount).
      return () => {
        cancelled = true
        subs.forEach((s) => s.unsubscribe())
        syncedRef.current = false
      }
    }

    const cleanup = run()
    return () => {
      cancelled = true
      void cleanup.then((fn) => fn?.())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, userId])
}
