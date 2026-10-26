/**
 * cloudSyncRows — how each synced table maps between local documents and
 * PostgREST rows. Shared so web and native can never disagree on a column;
 * each platform adds only its local storage side (list/apply/remove/restamp,
 * see TableAdapter in ./cloudSync.ts).
 */

import type { RowSpec } from './cloudSync'
import type {
  RouteDocType, AircraftProfileDocType, UserWaypointDocType, FlightLogDocType,
} from './types'

const iso = (ms: number) => new Date(ms).toISOString()
const ts  = (v: unknown) => { const t = Date.parse(String(v)); return Number.isFinite(t) ? t : 0 }
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v ?? fallback) as T
  try { return JSON.parse(v) as T } catch { return fallback }
}
/** Drop storage-internal fields (RxDB's _rev, _meta, _deleted, _attachments). */
const plain = <T>(doc: T): T =>
  Object.fromEntries(Object.entries(doc as Record<string, unknown>).filter(([k]) => !k.startsWith('_'))) as T

const byId = <L extends { id: string; updatedAt: number }>(l: L) => ({ id: l.id, updatedAt: l.updatedAt })

export const routeRows: RowSpec<RouteDocType> = {
  table: 'user_routes',
  version: byId,
  fromServer: r => ({
    id:           String(r.id),
    name:         String(r.name ?? ''),
    waypoints:    json(r.waypoints, []),
    legOverrides: json(r.leg_overrides, []),
    aircraftId:   String(r.aircraft_id ?? ''),
    updatedAt:    ts(r.updated_at),
  }),
  toServer: (r, userId) => ({
    id:            r.id,
    user_id:       userId,
    name:          r.name,
    waypoints:     r.waypoints ?? [],
    leg_overrides: r.legOverrides ?? [],
    aircraft_id:   r.aircraftId ?? '',
    updated_at:    iso(r.updatedAt),
  }),
}

export const aircraftRows: RowSpec<AircraftProfileDocType> = {
  table: 'user_aircraft_profiles',
  version: byId,
  fromServer: r => {
    const data = json<AircraftProfileDocType | null>(r.data, null)
    return data ? { ...plain(data), id: String(r.id), updatedAt: ts(r.updated_at) } : null
  },
  toServer: (a, userId) => ({ id: a.id, user_id: userId, data: plain(a), updated_at: iso(a.updatedAt) }),
}

export const waypointRows: RowSpec<UserWaypointDocType> = {
  table: 'user_waypoints',
  version: byId,
  fromServer: r => ({
    id:        String(r.id),
    name:      String(r.name ?? ''),
    lng:       Number(r.lng),
    lat:       Number(r.lat),
    folder:    String(r.folder ?? ''),
    updatedAt: ts(r.updated_at),
  }),
  toServer: (w, userId) => ({
    id: w.id, user_id: userId, name: w.name, lng: w.lng, lat: w.lat,
    folder: w.folder ?? '', updated_at: iso(w.updatedAt),
  }),
}

/**
 * Whether a local flight log may go to the server: completed, and not
 * recorded from a simulator. The in-progress log and simulated logs never
 * leave the device -- the cloud logbook holds real flights only.
 */
export function isSyncableLog(l: { endedAt: number; simulated?: boolean }): boolean {
  return l.endedAt > 0 && l.simulated !== true
}

// Editable by the owner since migration 20261110000000 (aircraft, merge,
// planned route); new logs still go up as plain inserts (insertNewRows), so
// they keep uploading to a server without that migration.
// Platform list() filters with isSyncableLog.
export const flightLogRows: RowSpec<FlightLogDocType> = {
  table: 'user_flight_logs',
  insertNewRows: true,
  uploadBatch: 1,     // tracks can be hundreds of KB each
  downloadBatch: 10,
  version: byId,
  fromServer: r => r.ended_at ? {
    id:            String(r.id),
    startedAt:     r.started_at ? ts(r.started_at) : 0,
    endedAt:       ts(r.ended_at),
    aircraftId:    String(r.aircraft_id ?? ''),
    registration:  String(r.registration ?? ''),
    trackJson:     String(r.track_json ?? '[]'),
    departureIcao: String(r.departure_icao ?? ''),
    arrivalIcao:   String(r.arrival_icao ?? ''),
    distanceNm:    Number(r.distance_nm ?? 0),
    maxAltFt:      Number(r.max_alt_ft ?? 0),
    updatedAt:     ts(r.updated_at),
    ...(typeof r.route_json === 'string' && r.route_json ? { routeJson: r.route_json } : {}),
  } : null,
  toServer: (l, userId) => ({
    id:             l.id,
    user_id:        userId,
    started_at:     l.startedAt ? iso(l.startedAt) : null,
    ended_at:       l.endedAt   ? iso(l.endedAt)   : null,
    aircraft_id:    l.aircraftId    ?? '',
    registration:   l.registration  ?? '',
    track_json:     l.trackJson     ?? '[]',
    departure_icao: l.departureIcao ?? '',
    arrival_icao:   l.arrivalIcao   ?? '',
    distance_nm:    l.distanceNm    ?? null,
    // INTEGER column: a fractional value (GPX altitude converted from metres) is refused with a 400
    // and the log would never upload.
    max_alt_ft:     l.maxAltFt != null && Number.isFinite(l.maxAltFt) ? Math.round(l.maxAltFt) : null,
    updated_at:     iso(l.updatedAt),
    // Only when there is a route: a server without the column (before migration
    // 20261110000000) would refuse every log otherwise. Safe only because logs go up
    // one per request (uploadBatch: 1 above): PostgREST bulk inserts need the same
    // keys in every row, so raising the batch size means sending route_json always
    // (null when none) once every server has the column.
    ...(l.routeJson ? { route_json: l.routeJson } : {}),
  }),
}

/** A setting with its locally kept modification time (settings docs have none). */
export interface SyncedSetting { id: string; value: string; updatedAt: number }

export const settingRows: RowSpec<SyncedSetting> = {
  table: 'user_settings',
  idColumn: 'key',
  version: s => ({ id: s.id, updatedAt: s.updatedAt }),
  fromServer: r => ({ id: String(r.key), value: String(r.value ?? ''), updatedAt: ts(r.updated_at) }),
  toServer: (s, userId) => ({ user_id: userId, key: s.id, value: s.value, updated_at: iso(s.updatedAt) }),
  // A setting never edited while signed in (time 0) may be a default or
  // another account's leftover: take the account's value, never upload it.
  canUpload: s => s.updatedAt > 0,
}
