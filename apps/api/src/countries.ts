/**
 * Country registry reads -- see db/migrations/20261001000000_countries.sql.
 *
 * GET /api/countries lists the countries a client may offer in its country
 * picker: enabled by an operator AND marked ready by the data pipeline
 * (all of that country's tiles/GeoJSON built and uploaded). Readiness, not
 * the enable flag alone, decides visibility, so a freshly enabled country
 * only appears once its data really exists, and then works immediately.
 *
 * Cached in memory for CACHE_MS: the list changes a few times a year and
 * every app start reads it. A failed refresh keeps serving the last good
 * list; with no list at all the endpoint answers 503 and clients fall back
 * to their own last-known list.
 */
import { EUROPEAN_REGIONS } from '@open-vfr/shared/regions'
import { pool } from './db.js'

const CACHE_MS = 60_000

export interface AvailableCountry {
  code: string
  name: string
}

const NAME_BY_CODE = new Map(EUROPEAN_REGIONS.map(r => [r.code, r.name]))

let _cached: AvailableCountry[] | null = null
let _cachedAt = 0
let _inFlight: Promise<AvailableCountry[] | null> | null = null

async function load(): Promise<AvailableCountry[] | null> {
  try {
    const { rows } = await pool.query<{ code: string }>(
      `SELECT code FROM countries
       WHERE enabled AND tiles_ready_at IS NOT NULL
       ORDER BY code`,
    )
    // Only codes the shared region table knows (bbox, ICAO prefixes, name):
    // anything else couldn't be scoped or labelled by clients anyway.
    _cached = rows
      .map(r => r.code.trim().toLowerCase())
      .filter(code => NAME_BY_CODE.has(code))
      .map(code => ({ code, name: NAME_BY_CODE.get(code)! }))
    _cachedAt = Date.now()
  } catch (e) {
    console.warn('[countries] registry read failed, serving last known list:', (e as Error).message)
  }
  return _cached
}

export async function getAvailableCountries(): Promise<AvailableCountry[] | null> {
  if (_cached && Date.now() - _cachedAt < CACHE_MS) return _cached
  _inFlight ??= load().finally(() => { _inFlight = null })
  return _inFlight
}

/** Drop the cache so the next read hits the database (after an admin change). */
export function invalidateCountries(): void {
  _cachedAt = 0
}
