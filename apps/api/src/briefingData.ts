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
import { routeRows, aircraftRows } from '@open-vfr/shared/cloudSyncRows'
import { countryDatasetFile, mergeFeatureCollections } from '@open-vfr/shared/countryData'
import { notamRegionsFor } from '@open-vfr/shared/notamRegionScope'
import { DEFAULT_REGION_CODES } from '@open-vfr/shared/regions'
import type { RouteDocType, AircraftProfileDocType } from '@open-vfr/shared/types'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import { AUTHENTICATED_ROLE } from './pgRoles'

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
  const rows = await postgrestGet(userId, '/user_routes?select=*&order=updated_at.desc&limit=200')
  return rows.map(r => routeRows.fromServer(r)).filter((r): r is RouteDocType => !!r)
}

/**
 * Create or replace one of the user's aircraft profiles through PostgREST as
 * that user (row-level security: only their own rows). Same row shape the
 * apps sync, so the profile reaches web and native on their next sync.
 */
export async function upsertUserAircraft(userId: string, doc: AircraftProfileDocType): Promise<void> {
  if (!POSTGREST_URL) throw new Error('POSTGREST_INTERNAL_URL is not set')
  const { jwt } = mintPostgrestJwt({ id: userId }, 60)
  const res = await fetch(`${POSTGREST_URL}/user_aircraft_profiles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(aircraftRows.toServer(doc, userId)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`PostgREST user_aircraft_profiles upsert -> ${res.status} ${(await res.text()).slice(0, 200)}`)
}

/**
 * Create or replace one of the user's saved routes as that user. The review
 * mark is written explicitly: the shared row mapping only ever clears it.
 */
export async function upsertUserRoute(userId: string, doc: RouteDocType): Promise<void> {
  if (!POSTGREST_URL) throw new Error('POSTGREST_INTERNAL_URL is not set')
  const { jwt } = mintPostgrestJwt({ id: userId }, 60)
  const res = await fetch(`${POSTGREST_URL}/user_routes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ ...routeRows.toServer(doc, userId), assistant_review: doc.assistantReview ?? null }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`PostgREST user_routes upsert -> ${res.status} ${(await res.text()).slice(0, 200)}`)
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

async function fetchDataset(url: string): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const fc = await res.json() as GeoJSON.FeatureCollection
    return Array.isArray(fc?.features) ? fc : null
  } catch {
    return null
  }
}

/** One dataset for some countries (merged); null when TILES_BASE_URL is unset or nothing loaded. */
export async function loadCountryDataset(kind: 'aerodromes' | 'airspace' | 'obstacles' | 'navaids' | 'waypoints', countries: readonly string[]): Promise<GeoJSON.FeatureCollection | null> {
  if (!TILES_BASE_URL || countries.length === 0) return null
  const now = Date.now()
  const parts = await Promise.all(countries.map(cc => {
    const url = `${TILES_BASE_URL}/${countryDatasetFile(cc, kind)}`
    let hit = datasetCache.get(url)
    if (!hit || now - hit.at > DATASET_TTL_MS) {
      hit = { at: now, fc: fetchDataset(url) }
      datasetCache.set(url, hit)
      // A failed load is not cached for the full TTL.
      void hit.fc.then(fc => { if (!fc) datasetCache.delete(url) })
    }
    return hit.fc
  }))
  const ok = parts.filter((p): p is GeoJSON.FeatureCollection => !!p)
  return ok.length > 0 ? mergeFeatureCollections(ok) : null
}

/** Countries a route touches, limited to those this deployment serves. */
export function routeCountries(waypoints: readonly RouteWaypoint[], available: readonly string[] | null): string[] {
  const touched = notamRegionsFor({ selected: [], route: [...waypoints] })
  const avail = available && available.length > 0 ? available : [...DEFAULT_REGION_CODES]
  const inScope = touched.filter(c => avail.includes(c))
  return inScope.length > 0 ? inScope : avail.slice(0, 1)
}
