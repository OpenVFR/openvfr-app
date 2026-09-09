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
 * Flight log tracks are stored separately with a size guard; tracks > 500 KB
 * are silently trimmed to the most recent 2,000 points.
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
  logs:      'ovfr:flight_logs',
} as const

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
async function readAll<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key)
    if (!raw) return []
    return JSON.parse(raw) as T[]
  } catch {
    return []
  }
}

async function writeAll<T>(key: string, items: T[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(items))
}

async function upsert<T extends { id: string }>(key: string, doc: T): Promise<void> {
  const items = await readAll<T>(key)
  const idx = items.findIndex(i => i.id === doc.id)
  if (idx >= 0) items[idx] = doc
  else items.push(doc)
  await writeAll(key, items)
}

async function remove(key: string, id: string): Promise<void> {
  const items = await readAll<{ id: string }>(key)
  await writeAll(key, items.filter(i => i.id !== id))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const routes = {
  getAll:    () => readAll<RouteDocType>(KEY.routes),
  get:       async (id: string) => (await readAll<RouteDocType>(KEY.routes)).find(r => r.id === id),
  upsert:    (doc: RouteDocType) => upsert(KEY.routes, doc),
  delete:    (id: string) => remove(KEY.routes, id),
}

// ---------------------------------------------------------------------------
// Aircraft Profiles
// ---------------------------------------------------------------------------
export const aircraft = {
  getAll:    () => readAll<AircraftProfileDocType>(KEY.aircraft),
  get:       async (id: string) => (await readAll<AircraftProfileDocType>(KEY.aircraft)).find(a => a.id === id),
  upsert:    (doc: AircraftProfileDocType) => upsert(KEY.aircraft, doc),
  delete:    (id: string) => remove(KEY.aircraft, id),
}

// ---------------------------------------------------------------------------
// User Waypoints
// ---------------------------------------------------------------------------
export const waypoints = {
  getAll:    () => readAll<UserWaypointDocType>(KEY.waypoints),
  upsert:    (doc: UserWaypointDocType) => upsert(KEY.waypoints, doc),
  delete:    (id: string) => remove(KEY.waypoints, id),
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

export const flightLogs = {
  getAll: () => readAll<FlightLogDocType>(KEY.logs),

  upsert: async (doc: FlightLogDocType): Promise<void> => {
    // Guard track size: trim to last MAX_TRACK_POINTS
    let d = doc
    if (doc.trackJson) {
      try {
        const pts: TrackPoint[] = JSON.parse(doc.trackJson)
        if (pts.length > MAX_TRACK_POINTS) {
          d = { ...doc, trackJson: JSON.stringify(pts.slice(-MAX_TRACK_POINTS)) }
        }
      } catch { /* leave as-is */ }
    }
    await upsert(KEY.logs, d)
  },

  delete: (id: string) => remove(KEY.logs, id),
}
