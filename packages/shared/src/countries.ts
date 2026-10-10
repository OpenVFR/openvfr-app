/**
 * Countries the deployment serves (GET /api/countries) and the user's
 * selection among them. Shared by web and native.
 *
 * The server lists a country only once it is enabled by an operator AND
 * its data has been built, so anything listed here works immediately.
 * Clients keep the last list they saw, so the picker still works offline
 * or when the api is briefly down.
 */
import { fetchWithRetry } from './fetchWithRetry'
import { DEFAULT_REGION_CODE } from './regions'

export interface AvailableCountry {
  /** ISO 3166-1 alpha-2, lower-case (same codes as ./regions). */
  code: string
  name: string
}

/** null when the server has no list (503) -- callers keep their last-known list. */
export async function fetchAvailableCountries(
  baseUrl = '',
  signal?: AbortSignal,
): Promise<AvailableCountry[] | null> {
  const resp = await fetchWithRetry(`${baseUrl}/api/countries`, { signal })
  if (resp.status === 503 || resp.status === 404) return null
  if (!resp.ok) throw new Error(`Country list fetch failed: HTTP ${resp.status}`)
  const json = await resp.json() as { countries?: unknown }
  if (!Array.isArray(json.countries)) return null
  return json.countries.filter((c): c is AvailableCountry =>
    !!c && typeof (c as AvailableCountry).code === 'string' && typeof (c as AvailableCountry).name === 'string')
}

/**
 * How many countries can be active at once. One for now: map data, offline
 * downloads and lookups are per country, and combining several countries'
 * data has open memory/design questions (see the country-registry entry
 * in the infra todo). The selection stays a list everywhere so raising
 * this later doesn't change any signature.
 */
export const MAX_SELECTED_COUNTRIES = 1

/**
 * The selection actually in effect: the saved selection limited to
 * countries still available, at most MAX_SELECTED_COUNTRIES. Never empty
 * while anything is available -- falls back to the default country if
 * available, else the first one. With no known list yet (first start
 * offline), the saved selection is trusted, or the default country.
 */
export function resolveSelectedCountries(
  saved: readonly string[],
  available: readonly AvailableCountry[] | null,
): string[] {
  const cap = (codes: string[]) => [...new Set(codes)].slice(0, MAX_SELECTED_COUNTRIES)
  if (!available) return saved.length > 0 ? cap([...saved]) : [DEFAULT_REGION_CODE]
  const codes = new Set(available.map(c => c.code))
  const kept = saved.filter(c => codes.has(c))
  if (kept.length > 0) return cap(kept)
  if (codes.has(DEFAULT_REGION_CODE)) return [DEFAULT_REGION_CODE]
  return available[0] ? [available[0].code] : []
}

/**
 * Pick a country. With a limit of one, picking replaces the selection;
 * otherwise it toggles, never removing the last country and never going
 * past the limit.
 */
export function toggleCountry(selected: readonly string[], code: string): string[] {
  if (MAX_SELECTED_COUNTRIES === 1) return [code]
  if (!selected.includes(code)) {
    return selected.length < MAX_SELECTED_COUNTRIES ? [...selected, code] : [...selected]
  }
  return selected.length > 1 ? selected.filter(c => c !== code) : [...selected]
}
