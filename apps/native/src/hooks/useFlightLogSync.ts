/**
 * useFlightLogSync — uploads completed flight logs to PostgREST and pulls
 * completed logs from other devices for cross-device history.
 *
 * Mirrors web's useSync.ts flight_logs handling:
 *   - Upload-only table (user_flight_logs): INSERT with ignore-duplicates,
 *     no UPDATE grant needed — a re-push of the same id is a safe no-op.
 *   - Only completed logs (endedAt > 0) are pushed — the in-progress
 *     skeleton never reaches the server.
 *   - Pull imports completed logs from all this user's devices into the
 *     local store so the Logs view shows full cross-device history.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { flightLogs as flightLogsDb } from '../db'
import type { FlightLogDocType } from '../types/db'
import { API_BASE } from '../config'
import { getSyncJwt } from '../utils/syncJwt'
import { useAuthContext } from '../context/AuthContext'
import { getLastSyncAt, setLastSyncAt } from './syncMeta'

const REST = `${API_BASE}/rest`

interface ServerFlightLog {
  id:             string
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

// JWT fetching moved to ../utils/syncJwt.ts (getSyncJwt) — shared across all sync hooks.

async function restFetch(jwt: string): Promise<ServerFlightLog[]> {
  const res = await fetch(`${REST}/user_flight_logs?select=*&order=updated_at.desc`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
  })
  if (!res.ok) return []
  return res.json() as Promise<ServerFlightLog[]>
}

// user_id is required — RLS WITH CHECK (auth_user_id() = user_id) plus the
// NOT NULL column with no default reject any insert missing it.
async function restUpsert(jwt: string, userId: string, doc: FlightLogDocType): Promise<boolean> {
  const res = await fetch(`${REST}/user_flight_logs`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=ignore-duplicates',
    },
    body: JSON.stringify({
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
    }),
  })
  if (!res.ok) {
    console.warn('[useFlightLogSync] restUpsert failed', res.status, await res.text().catch(() => ''))
    return false
  }
  return true
}

async function restDelete(jwt: string, id: string): Promise<boolean> {
  const res = await fetch(`${REST}/user_flight_logs?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    console.warn('[useFlightLogSync] restDelete failed', res.status, await res.text().catch(() => ''))
    return false
  }
  return true
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export function useFlightLogSync(authenticated: boolean) {
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [logs, setLogs]           = useState<FlightLogDocType[]>([])
  const syncedRef  = useRef(false)
  const pushedRef  = useRef<Set<string>>(new Set())
  const { state: authState } = useAuthContext()
  const userId = authState.status === 'authenticated' ? authState.user.id : null

  const refresh = useCallback(async () => {
    setLogs(await flightLogsDb.getAll())
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Exposed so callers (e.g. pull-to-refresh on the Logs segment) can trigger
  // an on-demand re-pull, not just the once-per-login automatic one below —
  // picks up logs recorded on another device while this session is running.
  const pull = useCallback(async () => {
    if (!authenticated) { await refresh(); return }
    setSyncState('syncing')
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('offline'); await refresh(); return }

    try {
      const serverLogs = await restFetch(jwt)
      const localLogs  = await flightLogsDb.getAll()

      for (const sl of serverLogs) {
        if (!sl.ended_at) continue
        const existing = localLogs.find(l => l.id === sl.id)
        if (existing) continue
        await flightLogsDb.upsert({
          id:            sl.id,
          startedAt:     sl.started_at ? new Date(sl.started_at).getTime() : 0,
          endedAt:       sl.ended_at   ? new Date(sl.ended_at).getTime()   : 0,
          aircraftId:    sl.aircraft_id    ?? '',
          registration:  sl.registration   ?? '',
          trackJson:     sl.track_json      ?? '[]',
          departureIcao: sl.departure_icao  ?? '',
          arrivalIcao:   sl.arrival_icao    ?? '',
          distanceNm:    sl.distance_nm     ?? 0,
          maxAltFt:      sl.max_alt_ft      ?? 0,
          updatedAt:     new Date(sl.updated_at).getTime(),
        })
      }

      const lastSyncAt = await getLastSyncAt()
      for (const local of localLogs) {
        if (local.endedAt <= 0) continue  // skip in-progress logs
        const onServer = serverLogs.find(sl => sl.id === local.id)
        if (onServer) continue
        if (lastSyncAt > 0 && local.updatedAt <= lastSyncAt) {
          // Missing server-side and unmodified since our last sync — deleted
          // (from this device via deleteLog, or another device) — remove
          // locally instead of resurrecting it.
          await flightLogsDb.delete(local.id)
          continue
        }
        if (userId) { await restUpsert(jwt, userId, local); pushedRef.current.add(local.id) }
      }
      await setLastSyncAt(Date.now())

      setSyncState('idle')
    } catch {
      setSyncState('error')
    }
    await refresh()
  }, [authenticated, refresh, userId])

  // Pull cross-device completed logs once per login, then push any completed
  // local logs the server doesn't have yet (e.g. recorded before login).
  useEffect(() => {
    if (!authenticated || syncedRef.current) return
    syncedRef.current = true
    pull()
  }, [authenticated, pull])

  // Push a single completed log immediately (call this when a log finishes,
  // e.g. from a poll on `logs` after useFlightLog reports activeLogId → null).
  const pushLog = useCallback(async (doc: FlightLogDocType) => {
    if (doc.endedAt <= 0 || pushedRef.current.has(doc.id)) return
    pushedRef.current.add(doc.id)
    await refresh()
    if (!authenticated || !userId) return
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('error'); return }
    try {
      const ok = await restUpsert(jwt, userId, doc)
      setSyncState(ok ? 'idle' : 'error')
    } catch {
      setSyncState('offline')  // offline-safe; will retry next login pull
    }
  }, [authenticated, refresh, userId])

  // Delete a completed log locally + (best-effort) on the server. Local
  // delete always succeeds even offline. Same limitation as
  // deleteAircraft/deleteRoute elsewhere: if the server DELETE fails while
  // still online (transient error, not full offline — offline short-circuits
  // pull() before it ever re-imports anything), a subsequent pull() could
  // re-import the still-server-side copy since the pull loop doesn't consult
  // a tombstone list. Accepted narrow race, consistent with the rest of the
  // sync layer — not specific to flight logs.
  const deleteLog = useCallback(async (id: string) => {
    await flightLogsDb.delete(id)
    await refresh()
    if (!authenticated) return
    const jwt = await getSyncJwt()
    if (!jwt) { setSyncState('error'); return }
    try {
      const ok = await restDelete(jwt, id)
      setSyncState(ok ? 'idle' : 'error')
    } catch {
      setSyncState('offline')  // offline-safe; reconciled on next pull
    }
  }, [authenticated, refresh])

  return { syncState, logs, refresh, pull, pushLog, deleteLog }
}
