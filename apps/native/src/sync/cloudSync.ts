/**
 * Native cloud sync: wires the shared two-way sync engine
 * (@open-vfr/shared/cloudSync — read its module comment for the model) to
 * AsyncStorage and the PostgREST JWT. Row mapping is shared with web
 * (@open-vfr/shared/cloudSyncRows); only the local storage side lives here.
 *
 * One SyncCoordinator per signed-in account, created by useCloudSyncLifecycle
 * (mounted once in App). The per-table hooks (useRouteSync, useAircraftSync,
 * useUserWaypointSync, useFlightLogSync) only read its state and report local
 * changes; the coordinator decides when to talk to the server:
 *   - at sign-in / app start, on every return to the foreground, every 5 min;
 *   - shortly after a local change;
 *   - with backoff after a failure (offline at the airfield, server down)
 *     until it goes through.
 *
 * Settings stay per-device on native and are not synced.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  SyncCoordinator, TableSync, queuePendingDelete, type RejectedRow,
  type SyncStatus, type SyncTable, type TableAdapter, type SyncStorage, type SyncTransport,
} from '@open-vfr/shared/cloudSync'
import { routeRows, aircraftRows, waypointRows, flightLogRows, isSyncableLog } from '@open-vfr/shared/cloudSyncRows'
import {
  routes as routesDb, aircraft as aircraftDb, waypoints as waypointsDb, flightLogs as flightLogsDb,
} from '../db'
import type { RouteDocType, AircraftProfileDocType, UserWaypointDocType, FlightLogDocType } from '../types/db'
import { API_BASE } from '../config'
import { getSyncJwt, invalidateSyncJwt } from '../utils/syncJwt'
import { syncLog } from '../utils/syncLog'

const routeAdapter: TableAdapter<RouteDocType> = {
  ...routeRows,
  // 'current' is the live working route, not a saved one (and not a UUID).
  list: async () => (await routesDb.listForSync()).filter(r => r.id !== 'current'),
  apply:   rows => routesDb.applyRemote(rows),
  remove:  rows => routesDb.removeRemote(rows),
  restamp: rows => routesDb.restampRemote(rows),
}

const aircraftAdapter: TableAdapter<AircraftProfileDocType> = {
  ...aircraftRows,
  list:    () => aircraftDb.listForSync(),
  apply:   rows => aircraftDb.applyRemote(rows),
  remove:  rows => aircraftDb.removeRemote(rows),
  restamp: rows => aircraftDb.restampRemote(rows),
}

const waypointAdapter: TableAdapter<UserWaypointDocType> = {
  ...waypointRows,
  list:    () => waypointsDb.listForSync(),
  apply:   rows => waypointsDb.applyRemote(rows),
  remove:  rows => waypointsDb.removeRemote(rows),
  restamp: rows => waypointsDb.restampRemote(rows),
}

const flightLogAdapter: TableAdapter<FlightLogDocType> = {
  ...flightLogRows,
  // The in-progress log never leaves the device.
  // Completed, real flights only: the in-progress log and simulated logs stay here.
  list:    async () => (await flightLogsDb.listForSync()).filter(isSyncableLog),
  apply:   rows => flightLogsDb.applyRemote(rows),
  remove:  rows => flightLogsDb.removeRemote(rows),
  restamp: rows => flightLogsDb.restampRemote(rows),
}

const storage: SyncStorage = {
  get:    k => AsyncStorage.getItem(`ovfr:sync:${k}`),
  set:    (k, v) => AsyncStorage.setItem(`ovfr:sync:${k}`, v),
  remove: k => AsyncStorage.removeItem(`ovfr:sync:${k}`),
}

const transport: SyncTransport = {
  restBase: `${API_BASE}/rest`,
  getJwt: getSyncJwt,
  invalidateJwt: invalidateSyncJwt,
  log: syncLog,
}

// ─── Coordinator lifecycle ──────────────────────────────────────────────────

let coordinator: SyncCoordinator | null = null
let coordinatorUser: string | null = null
let previousStop: Promise<void> = Promise.resolve()
let generation = 0
const lifecycleListeners = new Set<() => void>()
const notifyLifecycle = () => { for (const l of lifecycleListeners) l() }

async function startFor(userId: string): Promise<void> {
  if (coordinatorUser === userId && coordinator) return
  const gen = ++generation
  // Another account's round must finish before this one starts, or it could
  // still write that account's rows into the shared local collections.
  await stopCloudSync()
  if (gen !== generation) return   // stopped or restarted meanwhile
  const tables = [routeAdapter, aircraftAdapter, waypointAdapter, flightLogAdapter]
    .map(a => new TableSync<unknown>(a as TableAdapter<unknown>, transport, storage, userId))
  coordinator = new SyncCoordinator(tables)
  coordinatorUser = userId
  coordinator.start()
  notifyLifecycle()
}

/**
 * Stop syncing and wait for a running round to finish (every request has a
 * timeout). Call before wiping local data (sign-out, account switch), or a
 * round still in flight could write the previous account's rows back.
 */
export async function stopCloudSync(): Promise<void> {
  const c = coordinator
  coordinator = null
  coordinatorUser = null
  if (c) {
    notifyLifecycle()
    previousStop = c.stop()
  }
  await previousStop
}

/** Mount once (App). Runs sync for the signed-in account. */
export function useCloudSyncLifecycle(userId: string | null): void {
  useEffect(() => {
    if (!userId) { generation++; void stopCloudSync(); return }
    void startFor(userId)
    // The process outlives app switches: catch up on every return to the
    // foreground (also the moment connectivity usually comes back after a
    // flight).
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') void coordinator?.syncAll()
    })
    return () => sub.remove()
  }, [userId])
}

/** A local row of `table` was created or edited: upload it soon. */
export function notifyLocalChange(table: SyncTable): void {
  coordinator?.requestSync(table)
}

/**
 * A local row of `table` was deleted: delete it on the server (queued until
 * it succeeds). Before sync has started (app start, sign-in in progress) the
 * delete is queued for whichever account sync starts for next.
 */
export async function notifyLocalDelete(table: SyncTable, id: string): Promise<void> {
  const c = coordinator
  try {
    const t = c?.get(table)
    if (t) await t.queueDelete(id)
    else await queuePendingDelete(storage, table, id)
  } catch (err) {
    syncLog('[sync] could not queue delete', table, id, err instanceof Error ? err.message : String(err))
  }
  c?.requestSync(table, 0)
}

/** Run a round for `table` now (pull-to-refresh). */
export async function syncNow(table?: SyncTable): Promise<void> {
  if (!coordinator) return
  if (table) await coordinator.syncTable(table)
  else await coordinator.syncAll()
}

/** Try to send everything; true when nothing local is left unsynced. */
export async function flushBeforeSignOut(): Promise<boolean> {
  if (!coordinator) return true
  await coordinator.syncAll()
  return !(await coordinator.hasUnsynced())
}

/**
 * Status of one table plus a counter that increases whenever a round changed
 * local rows (reload lists when it changes).
 */
export function useTableSync(table: SyncTable): { status: SyncStatus; localVersion: number } {
  const [localVersion, setLocalVersion] = useState(0)
  const c = useSyncExternalStore(
    (cb) => { lifecycleListeners.add(cb); return () => { lifecycleListeners.delete(cb) } },
    () => coordinator,
  )
  const status = useSyncExternalStore(
    (cb) => c?.subscribe(cb) ?? (() => {}),
    () => c?.get(table)?.status ?? 'idle',
  )
  useEffect(() => {
    const t = c?.get(table)
    if (!t) return
    return t.subscribe(r => { if (r?.changedLocal) setLocalVersion(v => v + 1) })
  }, [c, table])
  return { status, localVersion }
}

// ─── Rows the server refused (shown in the lists) ───────────────────────────

const rejectedCache = new Map<SyncTable, { key: string; map: ReadonlyMap<string, RejectedRow> }>()
const NO_REJECTED: ReadonlyMap<string, RejectedRow> = new Map()

/** A stable snapshot (same object while nothing changed), as useSyncExternalStore requires. */
function rejectedSnapshot(c: SyncCoordinator | null, table: SyncTable): ReadonlyMap<string, RejectedRow> {
  const live = c?.get(table)?.rejected
  if (!live || live.size === 0) return NO_REJECTED
  const key = [...live.values()].map((r) => `${r.id}:${r.reason}`).join('|')
  const cached = rejectedCache.get(table)
  if (cached && cached.key === key) return cached.map
  const map = new Map(live)
  rejectedCache.set(table, { key, map })
  return map
}

/**
 * Local rows of `table` the server refused for good (too large, account limit):
 * they exist on this device only. Lists show a note on those rows.
 */
export function useSyncRejected(table: SyncTable): ReadonlyMap<string, RejectedRow> {
  const c = useSyncExternalStore(
    (cb) => { lifecycleListeners.add(cb); return () => { lifecycleListeners.delete(cb) } },
    () => coordinator,
  )
  return useSyncExternalStore(
    (cb) => c?.subscribe(cb) ?? (() => {}),
    () => rejectedSnapshot(c, table),
  )
}
