/**
 * fetchNotams — NOTAM fetch + date formatter.
 * Shared between web and native. Pass baseUrl='' for web; API_BASE for native.
 */

import { fetchWithRetry } from './fetchWithRetry'

export type NotamPolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

/** Structured ICAO NOTAM message fields (raw upstream strings, trimmed). */
export interface NotamIcaoFields {
  type:        string | null  // N (new) / R (replace) / C (cancel)
  issued:      string | null
  traffic:     string | null  // I / V / IV / K
  purpose:     string | null
  scope:       string | null  // A / E / W / AE / AW / K
  lowerFl:     string | null  // Q-line lower FL, "000"
  upperFl:     string | null  // Q-line upper FL, "999"
  coordinates: string | null  // DDMMNDDDMME
  radius:      string | null  // NM as given, "005"
  location:    string | null  // A)
  schedule:    string | null  // D)
  lowerLimit:  string | null  // F)
  upperLimit:  string | null  // G)
  estimated:   boolean        // C) marked EST
}

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
  // ICAO NOTAM Code, e.g. "QMRLC" (runway closed) -- decode with
  // @open-vfr/shared/notamQCode's notamTitle(). Optional: older API
  // deployments/cached responses predate it; null when upstream had none.
  qCode?:         string | null
  // FIR the NOTAM is filed in (e.g. "ESAA"), and whether it covers that
  // whole FIR (Q-line radius 999) -- the only geographic scope a
  // positionless NOTAM has. See notamRelevance.ts. Optional: older API
  // deployments predate them.
  affectedFir?:   string | null
  firWide?:       boolean
  // Structured ICAO message fields for the Raw/Full text views -- see
  // notamIcaoFormat.ts. Optional for the same reason.
  icao?:          NotamIcaoFields | null
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
  // Region codes to scope to (see ./notamRegionScope's notamRegionsFor()).
  // Empty/omitted = unscoped.
  regions?: string[],
): Promise<NotamResult> {
  const scope = regions && regions.length > 0
    ? `?regions=${encodeURIComponent([...new Set(regions)].sort().join(','))}`
    : ''
  const url = `${baseUrl}/api/notam/regional${scope}`
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
  // Region codes whose aerodromes to include (see ./notamRegionScope's
  // regionsForIcaos()). Empty/omitted = the server default (Sweden).
  regions?: string[],
): Promise<Record<string, string[]>> {
  const scope = regions && regions.length > 0
    ? `?regions=${encodeURIComponent([...new Set(regions)].sort().join(','))}`
    : ''
  const url = `${baseUrl}/api/notam/aerodrome-texts${scope}`
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
