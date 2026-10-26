/**
 * Web cloud sync: wires the shared two-way sync engine
 * (@open-vfr/shared/cloudSync — read its module comment for the model) to
 * RxDB and the PostgREST JWT. Row mapping is shared with native
 * (@open-vfr/shared/cloudSyncRows); only the RxDB side lives here.
 *
 * One SyncCoordinator per signed-in account (startCloudSync/stopCloudSync,
 * driven by useSync). Rounds run at sign-in, shortly after a local change,
 * every 5 min, when the tab becomes visible or the browser comes back online,
 * and with backoff after a failure.
 *
 * Local edits are picked up from the RxDB change streams (installChangeCapture,
 * once per page, independent of sign-in), so the rest of the app just writes
 * to RxDB as before. A delete made before sync has started for the account
 * is queued and sent once it does. Writes made by the sync itself also
 * appear in the change streams; they are recognised and not treated as
 * local edits.
 */

import type { RxCollection, RxChangeEvent } from 'rxdb'
import {
  SyncCoordinator, TableSync, queuePendingDelete, type RejectedRow,
  type SyncStatus, type SyncTable, type TableAdapter, type SyncStorage, type SyncTransport,
  type Tombstone, type Restamp,
} from '@open-vfr/shared/cloudSync'
import {
  routeRows, aircraftRows, waypointRows, flightLogRows, settingRows, isSyncableLog, type SyncedSetting,
} from '@open-vfr/shared/cloudSyncRows'
import { useSyncExternalStore } from 'react'
import { getDb, type OpenVfrDb } from '../db'
import type {
  RouteDocType, AircraftProfileDocType, UserWaypointDocType, FlightLogDocType,
} from '../db'
import { getSyncOwner } from '../db/userScope'
import { API_BASE_URL } from '../utils/env'
import { captureIsPaused } from './captureGate'

const log = (...a: unknown[]) => console.info(...a)

// ─── JWT ────────────────────────────────────────────────────────────────────
// The PostgREST JWT lives one hour; long sessions need fresh ones, not one
// fetched at sign-in. Sync fetches and caches its own.

let jwtCache: { jwt: string; exp: number } | null = null
/** A fetch in progress: the tables of one round ask at once; share one request. */
let jwtInflight: Promise<string | null> | null = null

function getSyncJwt(): Promise<string | null> {
  if (jwtCache && Date.now() < jwtCache.exp) return Promise.resolve(jwtCache.jwt)
  jwtInflight ??= fetchSyncJwt().finally(() => { jwtInflight = null })
  return jwtInflight
}

async function fetchSyncJwt(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/token`, { credentials: 'include' })
    if (!res.ok) {
      console.warn('[sync] /api/auth/token failed', res.status)
      return null
    }
    const body = await res.json() as { jwt: string; expiresAt: number }
    jwtCache = { jwt: body.jwt, exp: (body.expiresAt - 60) * 1000 }
    return body.jwt
  } catch (err) {
    console.warn('[sync] /api/auth/token threw', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ─── Writes made by the sync (skip them in the change streams) ──────────────
// Cleared on stop: a marker whose change event never came (no-op write)
// must not later swallow a real edit.

const appliedVersion = new Map<string, number | string>()   // `${table}|${id}` -> updatedAt (settings: value)
const removedBySync  = new Set<string>()
const k = (table: SyncTable, id: string) => `${table}|${id}`

function fromSyncWrite(table: SyncTable, id: string, marker: number | string): boolean {
  const key = k(table, id)
  if (appliedVersion.get(key) !== marker) return false
  appliedVersion.delete(key)
  return true
}

function fromSyncDelete(table: SyncTable, id: string): boolean {
  return removedBySync.delete(k(table, id))
}

/** Strip RxDB's internal fields (_rev, _meta, _deleted, _attachments). */
function plain<T>(doc: T): T {
  return Object.fromEntries(Object.entries(doc as Record<string, unknown>).filter(([key]) => !key.startsWith('_'))) as T
}

// ─── Settings modification times ────────────────────────────────────────────
// Settings docs have no updatedAt of their own; keep one per key here so
// settings follow the same last-write-wins rule as everything else. A setting
// never edited while signed in counts as 0: download-only (settingRows).

const SETTINGS_TIMES_KEY = 'openvfr.sync.settingsTimes'
function settingsTimes(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SETTINGS_TIMES_KEY) ?? '{}') as Record<string, number> } catch { return {} }
}
function setSettingTime(key: string, ts: number | null): void {
  const t = settingsTimes()
  if (ts === null) delete t[key]
  else t[key] = ts
  localStorage.setItem(SETTINGS_TIMES_KEY, JSON.stringify(t))
}

// ─── Adapters: RxDB side ────────────────────────────────────────────────────

/** apply/remove/restamp for collections whose docs carry updatedAt. */
function versionedOps<L extends { id: string; updatedAt: number }>(table: SyncTable, col: RxCollection<L>) {
  return {
    async apply(rows: L[]) {
      for (const r of rows) {
        const cur = await col.findOne(r.id).exec()
        if (cur && cur.get('updatedAt') >= r.updatedAt) continue
        appliedVersion.set(k(table, r.id), r.updatedAt)
        await col.upsert(r as never)
      }
    },
    async remove(rows: Tombstone[]) {
      for (const t of rows) {
        const cur = await col.findOne(t.id).exec()
        if (!cur || cur.get('updatedAt') > t.deletedAt) continue
        removedBySync.add(k(table, t.id))
        await cur.remove()
      }
    },
    async restamp(rows: Restamp[]) {
      for (const r of rows) {
        const cur = await col.findOne(r.id).exec()
        if (!cur || cur.get('updatedAt') !== r.from) continue
        appliedVersion.set(k(table, r.id), r.to)
        await cur.incrementalPatch({ updatedAt: r.to } as never)
      }
    },
  }
}

const listOf = async <T>(col: RxCollection<T>) => (await col.find().exec()).map(d => plain(d.toJSON() as T))

function adapters(db: OpenVfrDb): TableAdapter<unknown>[] {
  const routes: TableAdapter<RouteDocType> = {
    ...(routeRows as TableAdapter<RouteDocType>),
    // 'current' is the live working route, not a saved one (and not a UUID).
    list: async () => (await listOf(db.routes)).filter(r => r.id !== 'current'),
    ...versionedOps('user_routes', db.routes),
  }
  const aircraft: TableAdapter<AircraftProfileDocType> = {
    ...(aircraftRows as unknown as TableAdapter<AircraftProfileDocType>),
    list: () => listOf(db.aircraft_profiles),
    ...versionedOps('user_aircraft_profiles', db.aircraft_profiles),
  }
  const waypoints: TableAdapter<UserWaypointDocType> = {
    ...(waypointRows as TableAdapter<UserWaypointDocType>),
    list: () => listOf(db.user_waypoints),
    ...versionedOps('user_waypoints', db.user_waypoints),
  }
  const settings: TableAdapter<SyncedSetting> = {
    ...(settingRows as TableAdapter<SyncedSetting>),
    list: async () => {
      const times = settingsTimes()
      return (await db.settings.find().exec()).map(d => ({ id: d.id, value: d.value, updatedAt: times[d.id] ?? 0 }))
    },
    async apply(rows) {
      for (const r of rows) {
        if ((settingsTimes()[r.id] ?? 0) >= r.updatedAt) continue
        const cur = await db.settings.findOne(r.id).exec()
        if (cur?.value !== r.value) {
          appliedVersion.set(k('user_settings', r.id), r.value)
          await db.settings.upsert({ id: r.id, value: r.value })
        }
        // Only after the value is in: a failed write is retried next round.
        setSettingTime(r.id, r.updatedAt)
      }
    },
    async remove(rows) {
      for (const t of rows) {
        if ((settingsTimes()[t.id] ?? 0) > t.deletedAt) continue
        const cur = await db.settings.findOne(t.id).exec()
        if (cur) {
          removedBySync.add(k('user_settings', t.id))
          await cur.remove()
        }
        setSettingTime(t.id, null)
      }
    },
    async restamp(rows) {
      for (const r of rows) if ((settingsTimes()[r.id] ?? 0) === r.from) setSettingTime(r.id, r.to)
    },
  }
  const logs: TableAdapter<FlightLogDocType> = {
    ...(flightLogRows as TableAdapter<FlightLogDocType>),
    // Completed, real flights only: the in-progress log and simulated logs
    // never leave the device.
    list: async () => (await db.flight_logs.find({ selector: { endedAt: { $gt: 0 } } }).exec())
      .map(d => plain(d.toJSON() as FlightLogDocType))
      .filter(isSyncableLog),
    ...versionedOps('user_flight_logs', db.flight_logs),
  }
  return [routes, aircraft, waypoints, settings, logs] as TableAdapter<unknown>[]
}

const storage: SyncStorage = {
  get:    async key => localStorage.getItem(`openvfr.sync.${key}`),
  set:    async (key, v) => localStorage.setItem(`openvfr.sync.${key}`, v),
  remove: async key => localStorage.removeItem(`openvfr.sync.${key}`),
}

const transport: SyncTransport = {
  restBase: `${API_BASE_URL}/rest`,
  getJwt: getSyncJwt,
  invalidateJwt: () => { jwtCache = null },
  log,
}

// ─── State ──────────────────────────────────────────────────────────────────

let coordinator: SyncCoordinator | null = null
let unsubCoordinator: (() => void) | null = null
let generation = 0
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

// ─── Change capture (once per page) ─────────────────────────────────────────

let captureInstalled: Promise<void> | null = null

/**
 * Watch the synced collections for local edits and deletes. Installed at app
 * start, before sign-in has finished, so a delete made while sync is still
 * starting is queued instead of lost (and later undone by a download).
 */
export function installChangeCapture(): Promise<void> {
  captureInstalled ??= (async () => {
    const db = await getDb()
    const watch = <T extends { id: string }>(
      table: SyncTable,
      col: RxCollection<T>,
      opts: { marker: (d: T) => number | string; skip?: (d: T) => boolean; onLocalEdit?: (d: T) => void },
    ) => col.$.subscribe((ev: RxChangeEvent<T>) => {
      const doc = (ev.documentData ?? ev.previousDocumentData) as T | undefined
      if (!doc || captureIsPaused()) return
      // Only data that belongs to an account (signed in, or signed in before
      // and not wiped) has anything on the server to delete or re-stamp.
      const c = coordinator
      if (!c && !getSyncOwner()) return
      if (ev.operation === 'DELETE') {
        if (fromSyncDelete(table, doc.id) || opts.skip?.(doc)) return
        const queued = c?.get(table)
          ? c.get(table)!.queueDelete(doc.id)
          : queuePendingDelete(storage, table, doc.id)
        void queued
          .catch(err => log('[sync] could not queue delete', table, doc.id, err instanceof Error ? err.message : String(err)))
          .finally(() => c?.requestSync(table, 0))
        return
      }
      if (opts.skip?.(doc)) return
      if (fromSyncWrite(table, doc.id, opts.marker(doc))) return
      opts.onLocalEdit?.(doc)
      c?.requestSync(table)
    })

    watch('user_routes', db.routes, { marker: d => d.updatedAt, skip: d => d.id === 'current' })
    watch('user_aircraft_profiles', db.aircraft_profiles, { marker: d => d.updatedAt })
    watch('user_waypoints', db.user_waypoints, { marker: d => d.updatedAt })
    watch('user_settings', db.settings, {
      marker: d => d.value,
      onLocalEdit: d => setSettingTime(d.id, Date.now()),
    })
    // Skips edits AND deletes of logs that never sync (in progress, simulated).
    watch('user_flight_logs', db.flight_logs, { marker: d => d.updatedAt, skip: d => !isSyncableLog(d) })
  })()
  return captureInstalled
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

const onVisible = () => { if (document.visibilityState === 'visible') void coordinator?.syncAll() }
const onOnline  = () => { void coordinator?.syncAll() }

/** Start syncing for `userId` (idempotent). */
export async function startCloudSync(userId: string): Promise<void> {
  if (coordinator) return
  const gen = ++generation
  await installChangeCapture()
  const db = await getDb()
  if (gen !== generation || coordinator) return   // stopped or restarted meanwhile
  const tables = adapters(db).map(a => new TableSync(a, transport, storage, userId))
  const c = new SyncCoordinator(tables)
  coordinator = c
  unsubCoordinator = c.subscribe(notify)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)
  c.start()
  notify()
}

/**
 * Stop syncing and wait for a running round to finish (every request has a
 * timeout). Call before wiping local data, or a round still in flight could
 * write rows back.
 */
export async function stopCloudSync(): Promise<void> {
  const c = coordinator
  generation++
  coordinator = null
  unsubCoordinator?.()
  unsubCoordinator = null
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('online', onOnline)
  jwtCache = null
  notify()
  await c?.stop()
  appliedVersion.clear()
  removedBySync.clear()
}

/** Try to send everything; true when nothing local is left unsynced. */
export async function flushBeforeSignOut(): Promise<boolean> {
  if (!coordinator) return true
  await coordinator.syncAll()
  return !(await coordinator.hasUnsynced())
}

/** Run a round now (all tables, or one). */
export async function syncNow(table?: SyncTable): Promise<void> {
  if (!coordinator) return
  if (table) await coordinator.syncTable(table)
  else await coordinator.syncAll()
}

export function getCloudSyncStatus(): SyncStatus {
  return coordinator?.status ?? 'idle'
}

export function subscribeCloudSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Forget settings modification times (local data wiped / account changed). */
export function clearSyncLocalState(): void {
  localStorage.removeItem(SETTINGS_TIMES_KEY)
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
  return useSyncExternalStore(subscribeCloudSync, () => rejectedSnapshot(coordinator, table))
}
