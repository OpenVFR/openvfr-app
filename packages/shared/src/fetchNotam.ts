/**
 * fetchNotams — NOTAM fetch + date formatter.
 * Shared between web and native. Pass baseUrl='' for web; API_BASE for native.
 */

import { fetchWithRetry } from './fetchWithRetry'

export type NotamPolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface NotamItem {
  id:             string
  // NMS-API's own globally-unique internal id, NOT the human-readable
  // published NOTAM number (that's `id` above). Different issuing
  // authorities reuse the same series+number+year (confirmed live: a
  // German EDWW NOTAM and an unrelated Italian one were both published as
  // "M3011/26") -- use nmsId for React keys / Set membership / dedup /
  // dismiss-state tracking, never `id` for that purpose, or a same-numbered
  // NOTAM from a different country silently collides with/shadows another.
  // `id` stays correct for DISPLAY (the number a pilot actually recognizes).
  nmsId:          string
  text:           string
  effective:      string | null
  expires:        string | null
  classification: string | null
  // The ICAO location/FIR code this NOTAM is filed under (e.g. "ESD873",
  // "ESAA" for a whole-FIR notice) -- present upstream on every NMS-API
  // record but previously dropped before reaching either client. Used to
  // give a regional-NOTAM list row a real "where" without opening it.
  icaoLocation:   string | null
  // Real multi-vertex area geometry straight from NMS-API's own GeoJSON
  // feature.geometry (see apps/api/src/notam.ts's extractNotamPolygon()) --
  // present only for NOTAMs whose subject area is an actual polygon, e.g.
  // cross-border military exercise areas. Takes priority over lat/lon/
  // radiusNm below when both would otherwise apply.
  polygon: NotamPolygonGeometry | null
  // Geo fields (see apps/api/src/notam.ts) -- present only when NMS-API
  // supplied a coordinates+radius pair, used to render an ad-hoc circle for
  // NOTAMs without a corresponding charted airspace polygon.
  lat:      number | null
  lon:      number | null
  radiusNm: number | null
}

export interface NotamResult {
  notams: NotamItem[]
}

export async function fetchNotams(
  icao: string,
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<NotamResult> {
  const url = `${baseUrl}/api/notam?icao=${encodeURIComponent(icao)}`
  // Retries transient network blips / 502-504 -- see fetchWithRetry.ts. A
  // 503 that persists past retries still falls through to the empty-result
  // fallback below, same as before -- a single brief 503 no longer
  // masquerades as "NOTAM service unavailable" for this ICAO.
  const resp = await fetchWithRetry(url, { signal, headers })
  if (resp.status === 503) return { notams: [] }
  if (!resp.ok) throw new Error(`NOTAM fetch failed: HTTP ${resp.status}`)
  return resp.json() as Promise<NotamResult>
}

/**
 * FIR-wide/regional NOTAMs (restricted/danger areas, navaid outages, AIRAC
 * amendments, military notices) -- not tied to any single airport ICAO.
 * See apps/api/src/notam.ts's getRegionalNotams() for the server-side
 * rationale (icaoLocation=ESAA is not in any per-airport lookup).
 */
export async function fetchRegionalNotams(
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<NotamResult> {
  const url = `${baseUrl}/api/notam/regional`
  const resp = await fetchWithRetry(url, { signal, headers })
  if (resp.status === 503) return { notams: [] }
  if (!resp.ok) throw new Error(`Regional NOTAM fetch failed: HTTP ${resp.status}`)
  return resp.json() as Promise<NotamResult>
}

/**
 * Bulk per-aerodrome active NOTAM texts -- { [icao]: string[] }, one request
 * for every allow-listed airport at once (see apps/api/src/notam.ts's
 * getAerodromeNotamTexts()). Used by the map's ATC status ring to apply
 * keyword-based ATC-closed / hours-changed heuristics (see ./atcStatus)
 * without one /api/notam request per towered airport.
 */
export async function fetchAerodromeNotamTexts(
  baseUrl = '',
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<Record<string, string[]>> {
  const url = `${baseUrl}/api/notam/aerodrome-texts`
  const resp = await fetchWithRetry(url, { signal, headers })
  if (resp.status === 503) return {}
  if (!resp.ok) throw new Error(`Aerodrome NOTAM texts fetch failed: HTTP ${resp.status}`)
  return resp.json() as Promise<Record<string, string[]>>
}

export function fmtNotamDate(iso: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const day   = d.getUTCDate().toString().padStart(2, '0')
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
    const hh    = d.getUTCHours().toString().padStart(2, '0')
    const mm    = d.getUTCMinutes().toString().padStart(2, '0')
    return `${day} ${month} ${hh}:${mm}Z`
  } catch {
    return iso
  }
}
