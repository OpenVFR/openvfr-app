/**
 * Data the server-side briefing needs, outside briefing.ts so that module
 * stays pure:
 *
 *  - The user's saved routes and aircraft, read through PostgREST with a
 *    short-lived token minted for that user, exactly as the apps read them.
 *    Row-level security still decides what is visible; the api's own
 *    database role keeps no access to user tables. Needs
 *    POSTGREST_INTERNAL_URL (the api's address for PostgREST); unset =
 *    saved routes and aircraft are unavailable to the briefing.
 *  - Aerodromes, airspace and obstacles from the tile host
 *    (TILES_BASE_URL), per country, cached in memory for a few hours.
 */
import { createHmac } from 'node:crypto'
import { routeRows, aircraftRows, waypointRows } from '@open-vfr/shared/cloudSyncRows'
import { countryDatasetFile, countryMefFile, mergeFeatureCollections } from '@open-vfr/shared/countryData'
import { parseMef, type MefGrid } from '@open-vfr/shared/mefGrid'
import { resolveMsaMargins, type MsaMargins } from '@open-vfr/shared/msaMargins'
import { resolveAirspaceLevels, type AirspaceAlertLevels } from '@open-vfr/shared/airspaceAlertLevel'
import { notamRegionsFor } from '@open-vfr/shared/notamRegionScope'
import { DEFAULT_REGION_CODES } from '@open-vfr/shared/regions'
import type { RouteDocType, AircraftProfileDocType, UserWaypointDocType } from '@open-vfr/shared/types'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import { AUTHENTICATED_ROLE } from './pgRoles'
import { TILE_FETCH_HEADERS } from './tileFetch.js'

/** A short-lived HS256 JWT that PostgREST accepts as this user (same claims as /api/auth/token). */
export function mintPostgrestJwt(user: { id: string; email?: string | null }, ttlS = 15 * 60, secret = process.env['BETTER_AUTH_SECRET'] ?? ''): { jwt: string; expiresAt: number } {
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set')
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ttlS
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    // Must match PostgREST's PGRST_JWT_AUD so the token can't be replayed
    // against anything else that shares the HS256 secret.
    aud: 'postgrest',
    role: AUTHENTICATED_ROLE,
    ...(user.email ? { email: user.email } : {}),
    iat: now,
    exp,
  })).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return { jwt: `${header}.${payload}.${sig}`, expiresAt: exp }
}

const POSTGREST_URL = (process.env['POSTGREST_INTERNAL_URL'] ?? '').trim().replace(/\/+$/, '')
const FETCH_TIMEOUT_MS = 8_000

/** Whether saved routes and aircraft can be read (POSTGREST_INTERNAL_URL set). */
export function userDataConfigured(): boolean {
  return POSTGREST_URL !== ''
}

async function postgrestGet(userId: string, path: string): Promise<Record<string, unknown>[]> {
  if (!POSTGREST_URL) throw new Error('POSTGREST_INTERNAL_URL is not set')
  const { jwt } = mintPostgrestJwt({ id: userId }, 60)
  const res = await fetch(`${POSTGREST_URL}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`PostgREST ${path.split('?')[0]} -> ${res.status}`)
  return await res.json() as Record<string, unknown>[]
}

/** The user's saved routes, newest first. */
export async function userRoutes(userId: string): Promise<RouteDocType[]> {
  const rows = await postgrestGet(userId, '/user_routes?select=*&order=updated_at.desc&limit=1000')
  return rows.map(r => routeRows.fromServer(r)).filter((r): r is RouteDocType => !!r)
}

/**
 * Create or replace one row of a user table through PostgREST as that user
 * (row-level security: only their own rows). With `seenUpdatedAt` (an update)
 * the row is only changed if it is still as it was read (no newer write from
 * the app since): otherwise a conflict error asks for a fresh read instead
 * of overwriting the pilot's edit.
 */
async function postgrestWrite(userId: string, table: string, row: Record<string, unknown>, seenUpdatedAt?: number): Promise<void> {
  if (!POSTGREST_URL) throw new Error('POSTGREST_INTERNAL_URL is not set')
  const { jwt } = mintPostgrestJwt({ id: userId }, 60)
  const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }
  if (seenUpdatedAt !== undefined && seenUpdatedAt > 0) {
    // Server times have microseconds: "not changed since" = older than the read time plus 1 ms.
    const { id, user_id: _u, ...changes } = row
    const res = await fetch(`${POSTGREST_URL}/${table}?id=eq.${encodeURIComponent(String(id))}&updated_at=lt.${encodeURIComponent(new Date(seenUpdatedAt + 1).toISOString())}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(changes), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`PostgREST ${table} update -> ${res.status} ${(await res.text()).slice(0, 200)}`)
    if (((await res.json().catch(() => [])) as unknown[]).length === 0) throw new WriteConflictError()
    return
  }
  const res = await fetch(`${POSTGREST_URL}/${table}`, {
    method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`PostgREST ${table} upsert -> ${res.status} ${(await res.text()).slice(0, 200)}`)
}

/** The row changed in the app (or was removed) after it was read: nothing was written. */
export class WriteConflictError extends Error {
  constructor() { super('Changed in the app since it was read: nothing was written. Read it again and repeat the change.') }
}

/** Create or replace one of the user's aircraft profiles. Same row shape the apps sync. */
export const upsertUserAircraft = (userId: string, doc: AircraftProfileDocType, seenUpdatedAt?: number) =>
  postgrestWrite(userId, 'user_aircraft_profiles', aircraftRows.toServer(doc, userId), seenUpdatedAt)

/** Create or replace one of the user's saved routes. The review mark is written explicitly: the shared row mapping only ever clears it. */
export const upsertUserRoute = (userId: string, doc: RouteDocType, seenUpdatedAt?: number) =>
  postgrestWrite(userId, 'user_routes', { ...routeRows.toServer(doc, userId), assistant_review: doc.assistantReview ?? null }, seenUpdatedAt)

/** The user's saved places (the app's "waypoints"), oldest first. */
export async function userPlaces(userId: string): Promise<UserWaypointDocType[]> {
  const rows = await postgrestGet(userId, '/user_waypoints?select=*&order=updated_at.asc&limit=1000')
  return rows.map(r => waypointRows.fromServer(r)).filter((w): w is UserWaypointDocType => !!w)
}

/** Create or replace one of the user's saved places. */
export const upsertUserPlace = (userId: string, doc: UserWaypointDocType, seenUpdatedAt?: number) =>
  postgrestWrite(userId, 'user_waypoints', waypointRows.toServer(doc, userId), seenUpdatedAt)

/** One logged flight without its GPS track. */
export interface FlightSummary {
  id: string
  startedAt: number
  endedAt: number
  registration: string
  aircraftId: string
  departure: string
  arrival: string
  distanceNm: number
  maxAltFt: number
}

/**
 * The user's most recent logged flights, newest first. The track column is
 * never selected: the assistant gets summaries, not positions.
 */
export async function userFlightSummaries(userId: string, limit = 1000): Promise<FlightSummary[]> {
  const cols = 'id,started_at,ended_at,aircraft_id,registration,departure_icao,arrival_icao,distance_nm,max_alt_ft'
  const rows = await postgrestGet(userId, `/user_flight_logs?select=${cols}&ended_at=not.is.null&order=ended_at.desc&limit=${limit}`)
  return rows.map(r => ({
    id: String(r['id']),
    startedAt: r['started_at'] ? Date.parse(String(r['started_at'])) : 0,
    endedAt: Date.parse(String(r['ended_at'])),
    registration: String(r['registration'] ?? ''),
    aircraftId: String(r['aircraft_id'] ?? ''),
    departure: String(r['departure_icao'] ?? ''),
    arrival: String(r['arrival_icao'] ?? ''),
    distanceNm: Number(r['distance_nm'] ?? 0) || 0,
    maxAltFt: Number(r['max_alt_ft'] ?? 0) || 0,
  })).filter(f => Number.isFinite(f.endedAt))
}

/** The user's aircraft profiles. */
export async function userAircraft(userId: string): Promise<AircraftProfileDocType[]> {
  const rows = await postgrestGet(userId, '/user_aircraft_profiles?select=*&limit=100')
  return rows.map(r => aircraftRows.fromServer(r)).filter((a): a is AircraftProfileDocType => !!a)
}

// ── Tile-host datasets ─────────────────────────────────────────────────────

const TILES_BASE_URL = (process.env['TILES_BASE_URL'] ?? '').trim().replace(/\/+$/, '')
const DATASET_TTL_MS = 6 * 60 * 60 * 1000
const datasetCache = new Map<string, { at: number; fc: Promise<GeoJSON.FeatureCollection | null> }>()

const lastDatasetWarn = new Map<string, number>()
/** A failed dataset load says why, at most once a minute per file (callers only see "not available"). */
function warnDataset(url: string, reason: string): void {
  const now = Date.now()
  if (now - (lastDatasetWarn.get(url) ?? 0) < 60_000) return
  lastDatasetWarn.set(url, now)
  console.warn(`[briefing-data] ${url} not loaded: ${reason}`)
}

async function fetchDataset(url: string): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const res = await fetch(url, { headers: TILE_FETCH_HEADERS, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) { warnDataset(url, `HTTP ${res.status}`); await res.body?.cancel().catch(() => undefined); return null }
    const fc = await res.json() as GeoJSON.FeatureCollection
    if (!Array.isArray(fc?.features)) { warnDataset(url, 'not a FeatureCollection'); return null }
    return fc
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause
    warnDataset(url, `${err instanceof Error ? err.message : String(err)}${cause ? ` (${cause.code ?? cause.message})` : ''}`)
    return null
  }
}

/** A merged dataset that says which countries' files could not be loaded (callers must not read "not loaded" as "none"). */
export type CountryDataset = GeoJSON.FeatureCollection & { missingCountries?: string[] }

/**
 * One dataset for some countries (merged); null when TILES_BASE_URL is unset or nothing loaded.
 * When only some countries loaded, `missingCountries` names the others.
 */
export async function loadCountryDataset(kind: 'aerodromes' | 'airspace' | 'obstacles' | 'landmarks' | 'navaids' | 'waypoints' | 'lakes', countries: readonly string[]): Promise<CountryDataset | null> {
  if (!TILES_BASE_URL) { warnDataset('TILES_BASE_URL', 'is not set: no aerodrome, airspace or navaid data for briefings and route tools'); return null }
  if (countries.length === 0) return null
  const now = Date.now()
  const parts = await Promise.all(countries.map(cc => {
    const url = `${TILES_BASE_URL}/${countryDatasetFile(cc, kind)}`
    let hit = datasetCache.get(url)
    if (!hit || now - hit.at > DATASET_TTL_MS) {
      const entry = { at: now, fc: fetchDataset(url) }
      hit = entry
      datasetCache.set(url, entry)
      // A failed load is not cached for the full TTL (unless a newer entry has replaced it since).
      void entry.fc.then(fc => { if (!fc && datasetCache.get(url) === entry) datasetCache.delete(url) })
    }
    return hit.fc
  }))
  const ok = parts.filter((p): p is GeoJSON.FeatureCollection => !!p)
  if (ok.length === 0) return null
  const missing = countries.filter((_, i) => !parts[i]).map(c => c.toUpperCase())
  return Object.assign(mergeFeatureCollections(ok), missing.length ? { missingCountries: missing } : {})
}

/** Countries a route touches, limited to those this deployment serves. */
export function routeCountries(waypoints: readonly RouteWaypoint[], available: readonly string[] | null): string[] {
  const touched = notamRegionsFor({ selected: [], route: [...waypoints] })
  const avail = available && available.length > 0 ? available : [...DEFAULT_REGION_CODES]
  const inScope = touched.filter(c => avail.includes(c))
  return inScope.length > 0 ? inScope : avail.slice(0, 1)
}

// ── Terrain grid (conservative MSA) ─────────────────────────────────────────

const MEF_TTL_MS = 24 * 60 * 60 * 1000
const mefCache = new Map<string, { at: number; grid: Promise<MefGrid | null> }>()

/**
 * Maximum-elevation grids (`<cc>-mef.mef`) for some countries, refreshed
 * daily; a missing or broken file is skipped and retried on the next call.
 */
export async function loadMefGridsFor(countries: readonly string[]): Promise<MefGrid[]> {
  if (!TILES_BASE_URL) return []
  const now = Date.now()
  const grids = await Promise.all(countries.map((cc) => {
    const url = `${TILES_BASE_URL}/${countryMefFile(cc)}`
    let hit = mefCache.get(url)
    if (!hit || now - hit.at > MEF_TTL_MS) {
      hit = {
        at: now,
        grid: fetch(url, { headers: TILE_FETCH_HEADERS, signal: AbortSignal.timeout(30_000) })
          .then(async r => (r.ok ? parseMef(new Uint8Array(await r.arrayBuffer())) : null))
          .catch(() => null),
      }
      mefCache.set(url, hit)
      const entry = hit
      void entry.grid.then(g => { if (!g && mefCache.get(url) === entry) mefCache.delete(url) })
    }
    return hit.grid
  }))
  return grids.filter((g): g is MefGrid => g !== null)
}

// ── The pilot's planning settings (synced) ──────────────────────────────────

/**
 * What the briefing reads from the user's synced settings: MSA margins and airspace alert levels,
 * the planned departure, the global wind and the aircraft selected in the app. Anything unset is
 * left out; `unreadable` says the margins or alert levels could not be read.
 */
export interface PlanningSettings {
  msaMargins?: Partial<MsaMargins>
  airspaceLevels?: AirspaceAlertLevels
  /** Planned departure set in the app (epoch ms). */
  takeoffMs?: number
  globalWind?: { dirDeg: number; speedKts: number }
  /** Aircraft selected in the app (web syncs it; native keeps it on the device). */
  selectedAircraftId?: string
  /** The pilot's margins or alert levels could not be read: defaults are used and the briefing says so. */
  unreadable?: boolean
}

/** Planning settings from the user's synced settings; {} when POSTGREST is not configured. */
export async function userPlanningSettings(userId: string): Promise<PlanningSettings> {
  if (!POSTGREST_URL) return {}
  let rows: Record<string, unknown>[]
  try {
    rows = await postgrestGet(userId, '/user_settings?select=key,value&key=in.(msa_margins,alert_banners,takeoff_time,global_wind,%22ovfr:selectedAircraft%22)')
  } catch (err) {
    console.error('[briefing] reading the pilot\'s settings failed:', err)
    return { unreadable: true }
  }
  const out: PlanningSettings = {}
  // One row at a time: a bad row loses only itself. Unreadable margins or alert
  // levels are flagged (the briefing says so, and a level below the pilot's own MSA
  // is not saved on defaults).
  for (const r of rows) {
    const key = String(r['key'] ?? '')
    const raw = String(r['value'] ?? '')
    try {
      if (key === 'ovfr:selectedAircraft') { if (raw) out.selectedAircraftId = raw; continue }
      if (key === 'takeoff_time') { const t = Date.parse(raw); if (Number.isFinite(t)) out.takeoffMs = t; continue }
      const v = JSON.parse(raw || 'null') as Record<string, unknown> | null
      if (!v || typeof v !== 'object') continue
      if (key === 'msa_margins') out.msaMargins = resolveMsaMargins(v as Partial<MsaMargins>)
      if (key === 'alert_banners' && v['airspaceLevels']) out.airspaceLevels = resolveAirspaceLevels(v['airspaceLevels'] as Partial<Record<string, unknown>>)
      if (key === 'global_wind' && Number.isFinite(Number(v['dirDeg'])) && Number.isFinite(Number(v['speedKts']))) {
        out.globalWind = { dirDeg: Number(v['dirDeg']), speedKts: Number(v['speedKts']) }
      }
    } catch (err) {
      console.error(`[briefing] setting ${key} of user ${userId} is not readable:`, err)
      if (key === 'msa_margins' || key === 'alert_banners') out.unreadable = true
    }
  }
  return out
}
