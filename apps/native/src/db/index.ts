/**
 * Persistence layer for open-vfr native.
 *
 * Uses AsyncStorage instead of RxDB/Dexie (browser-only). The data types and
 * key names are identical to the web project so data can be round-tripped
 * via cloud sync (Phase 6). SQLite via expo-sqlite is the planned upgrade path
 * for Phase 6.
 *
 * Each collection is stored as a JSON-serialised array under a namespaced key.
 * Writes are atomic (full array replacement) — suitable for the data volumes
 * involved (routes, aircraft profiles, waypoints).
 *
 * Flight logs are the exception: one key per log (`ovfr:flight_log:<id>`).
 * The in-progress log is saved every few seconds during a flight, and with a
 * single array key every save re-read and re-wrote every past flight's track
 * too (about 1 MB/s of storage traffic with a modest logbook). Tracks are
 * trimmed to the most recent 2,000 points.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type {
  RouteDocType,
  AircraftProfileDocType,
  UserWaypointDocType,
  SettingsDocType,
  FlightLogDocType,
  TrackPoint,
} from '../types/db'

export type { RouteDocType, AircraftProfileDocType, UserWaypointDocType, SettingsDocType, FlightLogDocType, TrackPoint }

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
const KEY = {
  routes:    'ovfr:routes',
  aircraft:  'ovfr:aircraft_profiles',
  waypoints: 'ovfr:user_waypoints',
  settings:  'ovfr:settings',
  /** Legacy single-array key for flight logs; migrated to per-log keys on first use. */
  logs:      'ovfr:flight_logs',
} as const

/** Prefix of the per-log keys (`ovfr:flight_log:<id>`). */
export const FLIGHT_LOG_KEY_PREFIX = 'ovfr:flight_log:'

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
/**
 * Read a collection. Throws when the stored value cannot be read or parsed:
 * every mutation goes through this, because writing back "[] plus my change"
 * after a failed read would silently discard every stored row.
 */
async function readAllOrThrow<T>(key: string): Promise<T[]> {
  const raw = await AsyncStorage.getItem(key)
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${key}: stored value is not a list`)
  return parsed as T[]
}

/** Read for display: an unreadable collection shows as empty (and is never written back). */
async function readAll<T>(key: string): Promise<T[]> {
  try {
    return await readAllOrThrow<T>(key)
  } catch {
    return []
  }
}

async function writeAll<T>(key: string, items: T[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(items))
}

// Read-modify-write on a whole-array key is not atomic: two concurrent
// upserts (e.g. the working-route autosave and a cloud pull) would both read
// the old array and the later write would silently drop the other's row.
// Serialise mutations per key.
const locks = new Map<string, Promise<unknown>>()
function withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  locks.set(key, run.catch(() => {}))
  return run
}

function upsert<T extends { id: string }>(key: string, doc: T): Promise<void> {
  return withLock(key, async () => {
    const items = await readAllOrThrow<T>(key)
    const idx = items.findIndex(i => i.id === doc.id)
    if (idx >= 0) items[idx] = doc
    else items.push(doc)
    await writeAll(key, items)
  })
}

function remove(key: string, id: string): Promise<void> {
  return withLock(key, async () => {
    const items = await readAllOrThrow<{ id: string }>(key)
    await writeAll(key, items.filter(i => i.id !== id))
  })
}

// Cloud-sync writes. Each row is re-checked against the current local copy
// under the key's lock: the user may have edited it while the sync round was
// talking to the server, and that newer local edit must win.
type Versioned = { id: string; updatedAt: number }

/** Write server rows that are new here or newer than the local copy. */
function applyRemote<T extends Versioned>(key: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return withLock(key, async () => {
    const items = await readAllOrThrow<T>(key)
    const idx = new Map(items.map((i, n) => [i.id, n]))
    for (const r of rows) {
      const n = idx.get(r.id)
      if (n === undefined) { idx.set(r.id, items.length); items.push(r) }
      else if (items[n].updatedAt < r.updatedAt) items[n] = r
    }
    await writeAll(key, items)
  })
}

/** Remove rows deleted on another device, unless edited here after that delete. */
function removeRemote(key: string, rows: { id: string; deletedAt: number }[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return withLock(key, async () => {
    const del = new Map(rows.map(r => [r.id, r.deletedAt]))
    const items = await readAllOrThrow<Versioned>(key)
    await writeAll(key, items.filter(i => !(del.has(i.id) && i.updatedAt <= del.get(i.id)!)))
  })
}

/** Adopt the server's stored updatedAt (clock guard), unless edited again since the upload. */
function restampRemote(key: string, rows: { id: string; from: number; to: number }[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return withLock(key, async () => {
    const by = new Map(rows.map(r => [r.id, r]))
    const items = await readAllOrThrow<Versioned>(key)
    let changed = false
    for (const i of items) {
      const r = by.get(i.id)
      if (r && i.updatedAt === r.from) { i.updatedAt = r.to; changed = true }
    }
    if (changed) await writeAll(key, items)
  })
}

type RemoteOps<T> = {
  /** Like getAll, but throws when the stored collection cannot be read. */
  listForSync:   () => Promise<T[]>
  applyRemote:   (rows: T[]) => Promise<void>
  removeRemote:  (rows: { id: string; deletedAt: number }[]) => Promise<void>
  restampRemote: (rows: { id: string; from: number; to: number }[]) => Promise<void>
}
function remoteOps<T extends Versioned>(key: string, prepare: (r: T) => T = r => r): RemoteOps<T> {
  return {
    listForSync:   () => readAllOrThrow<T>(key),
    applyRemote:   rows => applyRemote(key, rows.map(prepare)),
    removeRemote:  rows => removeRemote(key, rows),
    restampRemote: rows => restampRemote(key, rows),
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const routes = {
  getAll:    () => readAll<RouteDocType>(KEY.routes),
  get:       async (id: string) => (await readAll<RouteDocType>(KEY.routes)).find(r => r.id === id),
  upsert:    (doc: RouteDocType) => upsert(KEY.routes, doc),
  delete:    (id: string) => remove(KEY.routes, id),
  ...remoteOps<RouteDocType>(KEY.routes),
}

// ---------------------------------------------------------------------------
// Aircraft Profiles
// ---------------------------------------------------------------------------
export const aircraft = {
  getAll:    () => readAll<AircraftProfileDocType>(KEY.aircraft),
  get:       async (id: string) => (await readAll<AircraftProfileDocType>(KEY.aircraft)).find(a => a.id === id),
  upsert:    (doc: AircraftProfileDocType) => upsert(KEY.aircraft, doc),
  delete:    (id: string) => remove(KEY.aircraft, id),
  ...remoteOps<AircraftProfileDocType>(KEY.aircraft),
}

// ---------------------------------------------------------------------------
// User Waypoints
// ---------------------------------------------------------------------------
export const waypoints = {
  getAll:    () => readAll<UserWaypointDocType>(KEY.waypoints),
  upsert:    (doc: UserWaypointDocType) => upsert(KEY.waypoints, doc),
  delete:    (id: string) => remove(KEY.waypoints, id),
  ...remoteOps<UserWaypointDocType>(KEY.waypoints),
}

// ---------------------------------------------------------------------------
// Settings  (key-value store; value is JSON-encoded string — same as web)
// ---------------------------------------------------------------------------
export const settings = {
  get: async <T>(id: string): Promise<T | null> => {
    const items = await readAll<SettingsDocType>(KEY.settings)
    const found = items.find(s => s.id === id)
    if (!found) return null
    try { return JSON.parse(found.value) as T } catch { return null }
  },
  set: async <T>(id: string, value: T): Promise<void> => {
    const doc: SettingsDocType = { id, value: JSON.stringify(value) }
    await upsert(KEY.settings, doc)
  },
  remove: (id: string) => remove(KEY.settings, id),
}

// ---------------------------------------------------------------------------
// Flight Logs
// ---------------------------------------------------------------------------
const MAX_TRACK_POINTS = 2_000

// Guard track size: trim to last MAX_TRACK_POINTS
function trimTrack(doc: FlightLogDocType): FlightLogDocType {
  if (!doc.trackJson) return doc
  try {
    const pts: TrackPoint[] = JSON.parse(doc.trackJson)
    if (pts.length > MAX_TRACK_POINTS) return { ...doc, trackJson: JSON.stringify(pts.slice(-MAX_TRACK_POINTS)) }
  } catch { /* leave as-is */ }
  return doc
}

// One lock for every flight-log operation (they are cheap now: one key each).
const LOGS_LOCK = 'flight_logs'
const logKey = (id: string) => FLIGHT_LOG_KEY_PREFIX + id

let logsMigrated: Promise<void> | null = null
/** Move logs from the legacy array key to per-log keys (once per process; idempotent). */
function migrateLogs(): Promise<void> {
  logsMigrated ??= (async () => {
    const raw = await AsyncStorage.getItem(KEY.logs)
    if (raw == null) return
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error(`${KEY.logs}: stored value is not a list`)
    const entries: Record<string, string> = {}
    for (const l of parsed as FlightLogDocType[]) if (l?.id) entries[logKey(l.id)] = JSON.stringify(l)
    if (Object.keys(entries).length > 0) await AsyncStorage.setMany(entries)
    await AsyncStorage.removeItem(KEY.logs)
  })().catch((err) => { logsMigrated = null; throw err })
  return logsMigrated
}

async function logKeys(): Promise<string[]> {
  await migrateLogs()
  return (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(FLIGHT_LOG_KEY_PREFIX))
}

/** All logs. Throws when storage cannot be read (an unparsable single log is skipped). */
async function readLogsOrThrow(): Promise<FlightLogDocType[]> {
  const keys = await logKeys()
  if (keys.length === 0) return []
  const values = await AsyncStorage.getMany(keys)
  const out: FlightLogDocType[] = []
  for (const k of keys) {
    const v = values[k]
    if (v == null) continue
    try { out.push(JSON.parse(v) as FlightLogDocType) } catch { /* skip a corrupt row */ }
  }
  return out
}

async function readLog(id: string): Promise<FlightLogDocType | undefined> {
  await migrateLogs()
  const v = await AsyncStorage.getItem(logKey(id))
  return v == null ? undefined : JSON.parse(v) as FlightLogDocType
}

const writeLog = (doc: FlightLogDocType) => AsyncStorage.setItem(logKey(doc.id), JSON.stringify(doc))

export const flightLogs = {
  getAll: async (): Promise<FlightLogDocType[]> => {
    try { return await readLogsOrThrow() } catch { return [] }
  },

  /** One log; waits for pending writes (e.g. read right after finishing a flight). */
  get: (id: string): Promise<FlightLogDocType | undefined> =>
    withLock(LOGS_LOCK, () => readLog(id)).catch(() => undefined),

  upsert: (doc: FlightLogDocType): Promise<void> =>
    withLock(LOGS_LOCK, async () => { await migrateLogs(); await writeLog(trimTrack(doc)) }),

  /** Merge `patch` into the stored log (no-op when it does not exist). Reads and writes only this log. */
  patch: (id: string, patch: Partial<FlightLogDocType>): Promise<void> =>
    withLock(LOGS_LOCK, async () => {
      const existing = await readLog(id)
      if (existing) await writeLog(trimTrack({ ...existing, ...patch, id }))
    }),

  delete: (id: string): Promise<void> =>
    withLock(LOGS_LOCK, async () => { await migrateLogs(); await AsyncStorage.removeItem(logKey(id)) }),

  /** Remove every stored log (sign-out / account switch). */
  wipeAll: async (): Promise<void> => {
    await AsyncStorage.removeItem(KEY.logs)
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(FLIGHT_LOG_KEY_PREFIX))
    if (keys.length > 0) await AsyncStorage.removeMany(keys)
    logsMigrated = null
  },

  // Cloud sync, same rules as the array collections above (local edit newer than the server wins).
  listForSync: (): Promise<FlightLogDocType[]> => readLogsOrThrow(),

  applyRemote: (rows: FlightLogDocType[]): Promise<void> => {
    if (rows.length === 0) return Promise.resolve()
    return withLock(LOGS_LOCK, async () => {
      await migrateLogs()
      const current = await AsyncStorage.getMany(rows.map(r => logKey(r.id)))
      const entries: Record<string, string> = {}
      for (const r of rows) {
        const raw = current[logKey(r.id)]
        let local: FlightLogDocType | null = null
        try { local = raw == null ? null : JSON.parse(raw) as FlightLogDocType } catch { /* corrupt: replace */ }
        if (!local || local.updatedAt < r.updatedAt) entries[logKey(r.id)] = JSON.stringify(trimTrack(r))
      }
      if (Object.keys(entries).length > 0) await AsyncStorage.setMany(entries)
    })
  },

  removeRemote: (rows: { id: string; deletedAt: number }[]): Promise<void> => {
    if (rows.length === 0) return Promise.resolve()
    return withLock(LOGS_LOCK, async () => {
      await migrateLogs()
      const current = await AsyncStorage.getMany(rows.map(r => logKey(r.id)))
      const drop: string[] = []
      for (const r of rows) {
        const raw = current[logKey(r.id)]
        if (raw == null) continue
        let local: FlightLogDocType | null = null
        try { local = JSON.parse(raw) as FlightLogDocType } catch { /* corrupt: drop */ }
        if (!local || local.updatedAt <= r.deletedAt) drop.push(logKey(r.id))
      }
      if (drop.length > 0) await AsyncStorage.removeMany(drop)
    })
  },

  restampRemote: (rows: { id: string; from: number; to: number }[]): Promise<void> => {
    if (rows.length === 0) return Promise.resolve()
    return withLock(LOGS_LOCK, async () => {
      await migrateLogs()
      const current = await AsyncStorage.getMany(rows.map(r => logKey(r.id)))
      const entries: Record<string, string> = {}
      for (const r of rows) {
        const raw = current[logKey(r.id)]
        if (raw == null) continue
        const local = JSON.parse(raw) as FlightLogDocType
        if (local.updatedAt === r.from) entries[logKey(r.id)] = JSON.stringify({ ...local, updatedAt: r.to })
      }
      if (Object.keys(entries).length > 0) await AsyncStorage.setMany(entries)
    })
  },
}
