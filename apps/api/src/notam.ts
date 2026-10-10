/**
 * server/src/notam.ts
 *
 * FAA NOTAM Management Service (NMS-API) poller + shared cache.
 *
 * Replaces the legacy external-api.faa.gov/notamapi/v1 integration (which
 * used static client_id/client_secret headers, per-request live calls, and
 * a per-user rate limit). That endpoint's replacement backend, NMS-API,
 * imposes tight *account-wide* (not per-user) production rate limits that
 * make a "live call per user request" design impossible:
 *
 *   - NOTAM delta pulls:     max 1 request every 3 minutes (whole account)
 *   - Initial Load / full
 *     classification pulls:  max 1 request every 24 hours
 *   - More frequent use requires FAA approval and will otherwise 429/error.
 *
 * (Pre-Prod/staging is looser — 1 req/s — but production is the above; see
 * the NMS API FAQ document supplied with your NMS credentials, "What is
 * the rate limit?".)
 *
 * Design:
 *  - ONE background poller, shared across all users, owns all NMS-API
 *    traffic. `/api/notam` in index.ts never calls NMS directly — it only
 *    reads this module's in-memory cache. This turns "N users each querying
 *    NOTAMs" into "N cache reads", decoupling user traffic from the FAA's
 *    account-wide throttle entirely.
 *  - Bootstrap (first poll after boot): GET /v1/notams?classification=INTERNATIONAL
 *    with NO lastUpdatedDate filter — this returns all *currently active*
 *    INTERNATIONAL-classification NOTAMs worldwide as GeoJSON. Filtered
 *    in-memory down to the supported European regions (INGEST_SCOPE). We
 *    deliberately do NOT use the /notams/il bulk endpoint for this — that
 *    endpoint is AIXM-5.1-only (no GeoJSON option), requiring a full AIXM
 *    XML parser for no benefit over the plain /notams query, which already
 *    supports GeoJSON and a classification filter.
 *  - Steady state: every POLL_INTERVAL_MS (>= 3 min, see below), GET the
 *    same endpoint with `lastUpdatedDate` set to the previous successful
 *    poll's timestamp, to fetch only what changed. Upserted into the cache
 *    keyed by icaoLocation + notam id.
 *  - Classification is fixed to INTERNATIONAL: Swedish (ESAA FIR) NOTAMs
 *    are classified INTERNATIONAL by NMS-API, not DOMESTIC (that split is
 *    new vs. the legacy FAA endpoint, which had no classification concept).
 *  - Active-window filtering (effectiveStart/effectiveEnd/cancelationDate)
 *    happens at *read* time (getNotamsForIcao), not at cache-write time —
 *    the cache keeps whatever NMS last told us about an id; expired/
 *    cancelled entries are simply not returned to callers, and get pruned
 *    from the cache opportunistically after each successful poll.
 *  - Disk-backed warm start: the bootstrap pull is expensive -- measured
 *    against staging, GET /v1/notams?classification=INTERNATIONAL (no
 *    location/date filter, since NMS-API's `location` param takes only a
 *    single ICAO/FIR code, not a list -- there is no way to ask for just
 *    "Sweden" or "Europe") returned ALL active INTERNATIONAL NOTAMs
 *    worldwide: 41,107 records, 8.1MB gzipped / 59.8MB decompressed, of
 *    which only 184 (33 unique ICAOs) were Swedish -- ~0.45% signal. A
 *    10-minute delta pull by contrast was ~118KB / 100 records. So the
 *    worldwide pull is fine as a one-time cost, but must not be repeated on
 *    every container restart. The cache is persisted to NMS_CACHE_FILE
 *    after every successful poll and reloaded on startup -- bootstrap only
 *    re-runs on a genuinely first-ever start (no cache file yet) or if that
 *    file/volume is lost, not on routine redeploys/restarts. The persisted
 *    file also records which NMS_API_HOST it came from; if that doesn't
 *    match the currently configured host (e.g. switching staging ->
 *    production), the stale cursor/entries are discarded automatically and
 *    a fresh bootstrap runs against the new host -- staging and production
 *    are separate NOTAM datasets, and reusing a cursor across them would
 *    silently under-populate the cache instead of properly bootstrapping.
 *
 * Required env vars (optional — NOTAM lookups disabled if unset, matching
 * the graceful-degradation pattern used elsewhere in this server):
 *   NMS_CLIENT_ID       OAuth2 client_credentials ID from NMS-API onboarding
 *   NMS_CLIENT_SECRET   OAuth2 client_credentials secret
 *   NMS_AUTH_HOST       host for POST /v1/auth/token (default: staging)
 *   NMS_API_HOST        host for GET /nmsapi/v1/notams (default: staging)
 *   NMS_CACHE_FILE      path for the persisted cache (default: /data/notam-cache.json --
 *                       requires a volume mounted at /data to actually
 *                       survive container restarts; without one this still
 *                       works, it just silently degrades back to
 *                       in-memory-only behavior, re-bootstrapping each start)
 *
 * Staging defaults intentionally — swap to production hosts only after
 * NOTAM Service Center confirms production onboarding is complete:
 *   NMS_AUTH_HOST=https://api-nms.aim.faa.gov
 *   NMS_API_HOST=https://api-nms.aim.faa.gov/nmsapi
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { notamInRegions, regionScope, type RegionScopeInput } from '@open-vfr/shared/notamRegionScope'
import { EUROPEAN_REGIONS } from '@open-vfr/shared/regions'

export type NotamPolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface NotamItem {
  id:             string
  // NMS-API's own globally-unique internal id, NOT the human-readable
  // published NOTAM number (that's `id` above). Different issuing
  // authorities reuse the same series+number+year (confirmed live: a
  // German EDWW NOTAM and an unrelated Italian one were both published as
  // "M3011/26") -- callers needing to dedupe a NOTAM list MUST use nmsId,
  // not id, or a same-numbered NOTAM from a different country silently
  // vanishes. Not meant for display.
  nmsId:          string
  text:           string
  effective:      string | null
  expires:        string | null
  classification: string | null
  // ICAO location/FIR code this NOTAM is filed under (e.g. "ESD873",
  // "ESAA" for a whole-FIR notice) -- present on every NmsNotam record but
  // previously dropped before reaching either client (kept mirrored with
  // @open-vfr/shared/fetchNotam's own NotamItem, which apps/api does NOT
  // import -- deliberately kept as its own separate copy here, matching
  // the existing duplication for every other field on this interface).
  icaoLocation:   string | null
  // ICAO NOTAM Code ("QMRLC"), see qCodeFor(). Mirrors shared NotamItem.qCode.
  qCode:          string | null
  // FIR the NOTAM is filed in (Q-line first item, e.g. "ESAA"). Mirrors
  // shared NotamItem.affectedFir -- lets clients scope NOTAMs that have no
  // usable position (whole-FIR notices) to the FIR(s) actually relevant.
  affectedFir:    string | null
  // True when the NOTAM covers its entire FIR (Q-line radius 999 NM, the
  // ICAO "whole FIR" convention). Its position is dropped as meaningless
  // (see radiusIsBogus below), so this is the only geographic hint left.
  firWide:        boolean
  // Structured ICAO fields for rebuilding the standard message layout
  // (Q/A/B/C/D/E/F/G items) -- see @open-vfr/shared/notamIcaoFormat.
  // Mirrors shared NotamIcaoFields. null when upstream supplied none.
  icao:           NotamIcaoFields | null
  // Real multi-vertex area geometry, straight from NMS-API's own GeoJSON
  // feature.geometry (never synthesized) -- present only for NOTAMs whose
  // subject area is an actual polygon/multipolygon (e.g. cross-border
  // military exercise areas defined by a list of lat/lon vertices in the
  // NOTAM text, which NMS-API itself resolves into real geometry). Mutually
  // exclusive in practice with the lat/lon/radiusNm circle fields below --
  // when both would apply, this takes priority (see activeNotamsFor()).
  // null for the common point/circle/textual-only cases.
  polygon: NotamPolygonGeometry | null
  // Geo fields, present only when NMS-API supplied a coordinates+radius pair
  // (parsed from DMS strings like "5939N01756E" + radius in NM) -- used to
  // render an ad-hoc circle for NOTAMs that don't correspond to a charted
  // airspace polygon (e.g. temporary restricted/danger areas established
  // mid-AIRAC-cycle). null when absent, e.g. purely textual NOTAMs.
  lat:      number | null
  lon:      number | null
  radiusNm: number | null
}

/** Mirrors @open-vfr/shared/fetchNotam's NotamIcaoFields (apps/api keeps its
 *  own copy of the wire types, same as NotamItem above). All raw upstream
 *  strings, trimmed; null when absent. */
export interface NotamIcaoFields {
  type:        string | null  // N (new) / R (replace) / C (cancel)
  issued:      string | null  // ISO timestamp
  traffic:     string | null  // I / V / IV / K
  purpose:     string | null  // e.g. "BO", "NBO", "M", "K"
  scope:       string | null  // A (aerodrome) / E (en-route) / W (nav warning) / AE / AW / K
  lowerFl:     string | null  // Q-line lower limit, 3-digit FL ("000")
  upperFl:     string | null  // Q-line upper limit, 3-digit FL ("999")
  coordinates: string | null  // Q-line DDMMNDDDMME
  radius:      string | null  // Q-line radius NM, as given ("005", "999")
  location:    string | null  // A) item
  schedule:    string | null  // D) item
  lowerLimit:  string | null  // F) item
  upperLimit:  string | null  // G) item
  estimated:   boolean        // C) end marked EST
}

export interface NotamResponse { notams: NotamItem[] }

const NMS_CLIENT_ID     = process.env['NMS_CLIENT_ID']     ?? ''
const NMS_CLIENT_SECRET = process.env['NMS_CLIENT_SECRET'] ?? ''
// || not ?? -- docker-compose's ${VAR:-} substitution sets an empty string
// when unset, and '' must fall through to the staging default same as
// undefined would (nullish coalescing alone would treat '' as a real value
// and silently break the default).
const NMS_AUTH_HOST  = process.env['NMS_AUTH_HOST']  || 'https://api-staging.cgifederal-aim.com'
const NMS_API_HOST   = process.env['NMS_API_HOST']   || 'https://api-staging.cgifederal-aim.com/nmsapi'
const NMS_CACHE_FILE = process.env['NMS_CACHE_FILE'] || '/data/notam-cache.json'

// FAA states "1 request every 3 minutes" as the production ceiling. Pad it
// so clock drift / slow requests never trip the account-wide throttle.
const POLL_INTERVAL_MS = 3 * 60 * 1000 + 20_000 // 3m20s

// Second, independent poller cadence for classification=MILITARY -- see
// pollMilitaryOnce()'s own header comment for the full design rationale.
// Padded well past 24h so clock drift never trips the FAA's "1 bulk pull
// every 24 hours at most" allowance -- this is a genuinely separate budget
// from POLL_INTERVAL_MS's 3-minute delta cadence above, not competing with
// it (confirmed against the production onboarding doc's own wording: "1
// data pull every 3 minutes" vs "1 bulk pull every 24 hours ... using
// either /IL functionality or full classification pulls of GeoJSON data").
const MILITARY_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000 // 24h10m

export const notamConfig = {
  available: Boolean(NMS_CLIENT_ID && NMS_CLIENT_SECRET),
}

// ── Ingest scope: every supported region, not just the enabled ones ───────
// NMS-API's `location` filter takes one ICAO code, not a list, so both
// classifications are pulled worldwide and filtered here. The cache keeps
// NOTAMs for ALL regions in @open-vfr/shared/regions (EUROPEAN_REGIONS),
// deliberately wider than the countries a deployment currently serves:
//  - enabling a country later needs no NOTAM backfill. A delta cursor only
//    returns records changed since the last poll, so a narrower scope that
//    grows would need a fresh worldwide pull to pick up long-standing
//    NOTAMs for the new country -- and full pulls are capped at 1 / 24 h;
//  - routes and positions cross into countries nobody selected, and those
//    NOTAMs must still be there (see notamRegionsFor() in
//    @open-vfr/shared/notamRegionScope).
// Clients never receive the whole cache: every endpoint filters per
// request by the regions the client asks for.
//
// A NOTAM is kept when it is filed in a supported region (ICAO prefix of
// its location or FIR, REGION_ICAO_PREFIXES) or its own geometry reaches
// into one (cross-border: e.g. a Kaliningrad-filed area over the Baltic).
// See notamInRegions() for the exact rule and its tests.
const INGEST_SCOPE = regionScope(EUROPEAN_REGIONS.map((r) => r.code))

// NMS-API uses radius="999" (and presumably similar round-number sentinels)
// as a placeholder for non-geographic administrative NOTAMs -- see
// activeNotamsFor()'s own comment for the confirmed live example. A NOTAM
// using the sentinel value must not be treated as a legitimate 999nm-radius
// circle (the shared scope test applies the same 100 NM ceiling).
const MAX_SANE_RADIUS_NM = 100

const MILITARY_EU_KEY  = '_MILITARY_EU' // synthetic cache key for the classification=MILITARY pull, see pollMilitaryOnce()

// Raw NMS record -> the fields notamInRegions() reads. Same geometry rules
// as activeNotamsFor(): real polygon first, else DMS point + radius (the
// sentinel-radius case falls back to a point test inside notamInRegions).
function scopeInputFor(n: NmsNotam): RegionScopeInput {
  const polygon = extractNotamPolygon(n.geometry)
  const geo = polygon ? null : parseNotamCoordinates(n.coordinates)
  const radiusNm = n.radius !== undefined ? Number(n.radius) : NaN
  return {
    icaoLocation: n.icaoLocation ?? null,
    affectedFir:  str(n.affectedFir),
    polygon,
    lat:          geo?.lat ?? null,
    lon:          geo?.lon ?? null,
    radiusNm:     Number.isFinite(radiusNm) ? radiusNm : null,
  }
}

function inIngestScope(n: NmsNotam): boolean {
  return notamInRegions(scopeInputFor(n), INGEST_SCOPE)
}

// "Regional" = not about one aerodrome: filed at FIR level (location is
// the FIR itself, e.g. ESAA -- restricted/danger areas, navaid outages,
// AIP amendments) or Q-line scope en-route (E) / navigation warning (W),
// including such NOTAMs filed at an aerodrome location (e.g. an obstacle
// near an airport that also matters en route). Pure aerodrome-scope NOTAMs
// stay in the per-airport lookups only.
function isRegional(n: NmsNotam): boolean {
  const loc = n.icaoLocation?.trim().toUpperCase()
  const fir = str(n.affectedFir)?.toUpperCase()
  if (loc && fir && loc === fir) return true
  const scope = str(n.scope)?.toUpperCase() ?? ''
  return scope.includes('E') || scope.includes('W')
}

// ── OAuth2 client_credentials token cache ──────────────────────────────────
let _token: { accessToken: string; expiresAt: number } | null = null

async function getNmsToken(): Promise<string> {
  if (_token && Date.now() < _token.expiresAt - 60_000) return _token.accessToken

  const resp = await fetch(`${NMS_AUTH_HOST}/v1/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${NMS_CLIENT_ID}:${NMS_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  })
  if (!resp.ok) throw new Error(`NMS auth failed: HTTP ${resp.status}`)
  const json = await resp.json() as { access_token?: string; expires_in?: string | number }
  if (!json.access_token) throw new Error('NMS auth response missing access_token')

  const expiresInS = Number(json.expires_in ?? 1800)
  _token = { accessToken: json.access_token, expiresAt: Date.now() + expiresInS * 1000 }
  return _token.accessToken
}

// ── Raw NMS GeoJSON NOTAM shape (subset of fields we use) ──────────────────
interface NmsNotam {
  id?:              string
  number?:          string
  text?:            string
  effectiveStart?:  string
  effectiveEnd?:    string
  classification?:  string
  icaoLocation?:    string
  // ICAO NOTAM Code / Q-code, e.g. "QMRLC" (sometimes without the leading Q).
  selectionCode?:   string
  // Remaining ICAO message fields (all confirmed present on live records;
  // values are raw strings, some with trailing spaces, e.g. purpose "BO ").
  type?:            string
  issued?:          string
  affectedFir?:     string
  traffic?:         string
  purpose?:         string
  scope?:           string
  minimumFl?:       string
  maximumFl?:       string
  location?:        string
  schedule?:        string
  lowerLimit?:      string
  upperLimit?:      string
  estimated?:       string | boolean
  cancelationDate?: string
  coordinates?:     string // DMS, e.g. "5939N01756E" (lat DDMM + N/S, lon DDDMM + E/W)
  radius?:          string // nautical miles, e.g. "5"
  // Raw feature.geometry from the NMS-API GeoJSON response (sibling of
  // properties.coreNOTAMData.notam, not part of it -- attached onto this
  // record at capture time in pollOnce() since that's the only place both
  // are in scope together). Real Polygon/MultiPolygon here means NMS-API
  // itself resolved the NOTAM text's area description into structured
  // geometry -- e.g. a multi-vertex military exercise box -- rather than
  // us only having a single DMS point + radius to go on. Point geometry is
  // ignored (the DMS coordinates+radius fields above already cover that
  // case and are more reliably present).
  geometry?: { type?: string; coordinates?: unknown } | null
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function icaoFieldsFor(n: NmsNotam): NotamIcaoFields | null {
  const f: NotamIcaoFields = {
    type:        str(n.type),
    issued:      str(n.issued),
    traffic:     str(n.traffic),
    purpose:     str(n.purpose),
    scope:       str(n.scope),
    lowerFl:     str(n.minimumFl),
    upperFl:     str(n.maximumFl),
    coordinates: str(n.coordinates),
    radius:      str(n.radius),
    location:    str(n.location) ?? str(n.icaoLocation),
    schedule:    str(n.schedule),
    lowerLimit:  str(n.lowerLimit),
    upperLimit:  str(n.upperLimit),
    estimated:   n.estimated === true || (typeof n.estimated === 'string' && /^(true|y|yes|est)$/i.test(n.estimated.trim())),
  }
  const any = Object.entries(f).some(([k, v]) => k !== 'estimated' && v !== null)
  return any ? f : null
}

// Checklist NOTAMs (Q-code QKKKK) only list which NOTAM numbers are
// currently valid in a FIR -- bookkeeping for briefing offices, no
// operational content for a pilot, and "whole FIR" sized. Excluded at the
// source so no client list, map layer or printout ever shows them.
function isChecklist(n: NmsNotam, qCode: string | null): boolean {
  return qCode === 'QKKKK' || /^\s*CHECKLIST\b/i.test(n.text ?? '')
}

// Q-code for a NOTAM: NMS-API's structured selectionCode when present,
// else the Q) line of ICAO-formatted text. Validated to exactly Q + 4
// letters so a malformed upstream value never reaches clients.
function qCodeFor(n: NmsNotam): string | null {
  const sel = n.selectionCode?.trim().toUpperCase() ?? ''
  if (/^Q[A-Z]{4}$/.test(sel)) return sel
  // Bare 4-letter form; no subject starts with Q, so "QXXX" is truncated.
  if (/^[A-PR-Z][A-Z]{3}$/.test(sel)) return `Q${sel}`
  const m = n.text ? /Q\)\s*[A-Z]{4}\s*\/\s*(Q[A-Z]{4})\s*\//.exec(n.text) : null
  return m?.[1] ?? null
}

// Parses NMS-API's DMS coordinate string format: 2-digit lat degrees,
// 2-digit lat minutes, N/S, 3-digit lon degrees, 2-digit lon minutes, E/W.
// Example: "5939N01756E" -> lat 59+39/60=59.65, lon 17+56/60=17.9333 --
// matches the real ESSA-area geometry NMS-API returns alongside this string
// (verified against a live sample: geometry.coordinates [17.918611,
// 59.651944] for coordinates "5939N01756E", i.e. within DMS rounding).
function parseNotamCoordinates(dms: string | undefined): { lat: number; lon: number } | null {
  if (!dms) return null
  const m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/.exec(dms.trim())
  if (!m) return null
  const [, latDeg, latMin, latHem, lonDeg, lonMin, lonHem] = m
  let lat = Number(latDeg) + Number(latMin) / 60
  let lon = Number(lonDeg) + Number(lonMin) / 60
  if (latHem === 'S') lat = -lat
  if (lonHem === 'W') lon = -lon
  return { lat, lon }
}
// Validates + narrows a raw feature.geometry down to a real Polygon/
// MultiPolygon we're willing to render -- Point geometry is deliberately
// ignored here (the DMS coordinates+radius fields already cover that case
// and are more reliably populated), and any other type (LineString etc.,
// not expected from NMS-API but not contractually guaranteed absent either)
// is dropped rather than trusted blindly. Structural validation only
// (finite lon/lat pairs, right nesting depth) -- NOT a ring-closure or
// self-intersection check, that's MapLibre/GeoJSON-consumer territory.
function isFiniteLonLat(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
}
function isValidRing(ring: unknown): ring is number[][] {
  return Array.isArray(ring) && ring.length >= 4 && ring.every(isFiniteLonLat)
}
function extractNotamPolygon(
  geometry: { type?: string; coordinates?: unknown } | null | undefined,
): NotamPolygonGeometry | null {
  if (!geometry) return null
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates
    if (Array.isArray(rings) && rings.length > 0 && rings.every(isValidRing)) {
      return { type: 'Polygon', coordinates: rings as number[][][] }
    }
    return null
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates
    if (
      Array.isArray(polys) && polys.length > 0 &&
      polys.every((rings) => Array.isArray(rings) && rings.length > 0 && rings.every(isValidRing))
    ) {
      return { type: 'MultiPolygon', coordinates: polys as number[][][][] }
    }
    return null
  }
  return null
}

interface NmsGeoJsonFeature {
  properties?: { coreNOTAMData?: { notam?: NmsNotam } }
  geometry?:   { type?: string; coordinates?: unknown } | null
}
interface NmsNotamsResponse {
  data?: { geojson?: NmsGeoJsonFeature[] }
}

// ── Shared cache: icaoLocation -> (notam id -> raw NMS record) ─────────────
const _cache = new Map<string, Map<string, NmsNotam>>()
let _lastPollAt: string | null = null // ISO timestamp of last successful poll start
let _lastMilitaryPullAt: string | null = null // ISO timestamp of last successful MILITARY bulk pull (persisted; gates the 1/24h limit across restarts)

// Grace period past effectiveEnd/cancelationDate before an entry is pruned
// from the cache entirely (not just excluded from getNotamsForIcao's active-
// window filter). Keeps the persisted file/memory footprint from growing
// unboundedly as NOTAMs get superseded/cancelled over time, while still
// tolerant of minor clock skew vs. NMS's own timestamps.
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000

// Max age of the persisted delta cursor when polls bring no changes -- see
// pollOnce(). A restart within this window re-reads at most this much delta.
const CURSOR_SAVE_MS = 30 * 60 * 1000
let _lastSavedAt = 0

// Fingerprint of the ingest scope (region prefixes + bboxes) this cache
// was populated against -- see loadCacheFromDisk(). Derived from the shared
// region table, so adding a region or changing a bbox there is caught
// automatically, no version number to bump by hand.
const INGEST_SCOPE_KEY = JSON.stringify({ prefixes: [...INGEST_SCOPE.prefixes].sort(), bboxes: INGEST_SCOPE.bboxes })

interface PersistedCache {
  apiHost:      string // NMS_API_HOST this cache was populated from -- see loadCacheFromDisk()
  scopeKey?:    string // INGEST_SCOPE_KEY this cache was populated with -- absent in caches from before Europe-wide ingest
  lastPollAt:   string | null
  lastMilitaryPullAt?: string | null // ISO time of the last SUCCESSFUL classification=MILITARY bulk pull -- see pollMilitaryOnce()
  entries: Array<[string, Array<[string, NmsNotam]>]> // [icaoLocation, [id, NmsNotam][]][]
}

function loadCacheFromDisk(): void {
  let raw: string
  try {
    raw = readFileSync(NMS_CACHE_FILE, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[notam] Failed to read disk cache, starting empty:', (e as Error).message)
    }
    return
  }
  try {
    const parsed = JSON.parse(raw) as PersistedCache

    // Safety check: staging and production are separate NOTAM datasets, but
    // lastUpdatedDate is just a wall-clock timestamp, not tied to which
    // host's data it was measured against. If the cache was populated from
    // a *different* NMS_API_HOST than the one currently configured (e.g.
    // switching staging -> production after onboarding), reusing that
    // cursor would send a stale-but-recent lastUpdatedDate to the new host
    // and get back only a narrow delta -- silently leaving the cache mostly
    // empty instead of properly bootstrapped from the new host. Discard the
    // cursor (and the entries, which are equally host-specific) and force a
    // full bootstrap against the newly configured host instead.
    if (parsed.apiHost !== NMS_API_HOST) {
      console.log(`[notam] Disk cache was for a different host (${parsed.apiHost ?? 'unknown'}), not ${NMS_API_HOST} -- discarding, will bootstrap fresh`)
      return
    }

    // The MILITARY bucket is a wholesale daily snapshot (no cursor), and its
    // last-pull time is account-level rate-limit state (1 full pull / 24 h)
    // -- both survive a scope change. Re-filtered to the current scope.
    _lastMilitaryPullAt = parsed.lastMilitaryPullAt ?? null
    const militaryEntries = parsed.entries.find(([key]) => key === MILITARY_EU_KEY)?.[1] ?? []
    const military = new Map(militaryEntries.filter(([, n]) => inIngestScope(n)))
    if (military.size > 0) _cache.set(MILITARY_EU_KEY, military)

    // Second safety check, same failure mode as the host check above but a
    // different trigger: lastUpdatedDate is a wall-clock cursor, not tied to
    // WHICH NOTAMs were being kept when it was set. If the ingest scope grew
    // since this cache was written, reusing the old cursor means delta polls
    // only return records CHANGED since then -- a long-standing NOTAM newly
    // in scope would never appear; only a full bootstrap (no cursor) catches
    // it. Confirmed in production once (adding 'ESAA' to the old allow-list
    // was never backfilled by delta polls). Missing scopeKey (cache from
    // before Europe-wide ingest) counts as changed: a one-time self-healing
    // bootstrap on the first restart after the upgrade.
    if (parsed.scopeKey !== INGEST_SCOPE_KEY) {
      console.log('[notam] Ingest scope changed (or cache predates it) -- discarding INTERNATIONAL entries and cursor, will bootstrap fresh')
      return
    }

    for (const [icao, idEntries] of parsed.entries) {
      if (icao !== MILITARY_EU_KEY) _cache.set(icao, new Map(idEntries))
    }
    _lastPollAt = parsed.lastPollAt
    const total = parsed.entries.reduce((n, [, idEntries]) => n + idEntries.length, 0)
    console.log(`[notam] Loaded ${total} cached NOTAMs from disk (${NMS_CACHE_FILE}), last poll: ${_lastPollAt ?? 'never'}`)
  } catch (e) {
    console.warn('[notam] Disk cache file unreadable, starting empty:', (e as Error).message)
  }
}

function saveCacheToDisk(): void {
  try {
    mkdirSync(dirname(NMS_CACHE_FILE), { recursive: true })
    const payload: PersistedCache = {
      apiHost:     NMS_API_HOST,
      scopeKey:    INGEST_SCOPE_KEY,
      lastPollAt:  _lastPollAt,
      lastMilitaryPullAt: _lastMilitaryPullAt,
      entries: [..._cache.entries()].map(([icao, byId]) => [icao, [...byId.entries()]]),
    }
    writeFileSync(NMS_CACHE_FILE, JSON.stringify(payload))
    _lastSavedAt = Date.now()
  } catch (e) {
    // Non-fatal -- worst case, next restart re-bootstraps instead of
    // warm-starting. Don't let a read-only/missing volume crash the poller.
    console.warn('[notam] Failed to persist disk cache:', (e as Error).message)
  }
}

// Drop entries that are long past relevance so the cache/file don't grow
// forever. Returns how many entries were removed (callers skip the disk
// write when nothing changed -- the Europe-wide file is tens of MB).
function pruneCache(): number {
  const cutoff = Date.now() - PRUNE_GRACE_MS
  let removed = 0
  for (const [icao, byId] of _cache) {
    for (const [id, n] of byId) {
      const cancelled = n.cancelationDate && Date.parse(n.cancelationDate) <= cutoff
      const expired   = n.effectiveEnd && Date.parse(n.effectiveEnd) < cutoff
      if (cancelled || expired) { byId.delete(id); removed++ }
    }
    if (byId.size === 0) _cache.delete(icao)
  }
  return removed
}

async function pollOnce(): Promise<void> {
  if (!notamConfig.available) return

  const wasBootstrap = !_lastPollAt
  const pollStartedAt = new Date().toISOString()
  try {
    const token = await getNmsToken()
    const params = new URLSearchParams({ classification: 'INTERNATIONAL' })
    if (_lastPollAt) params.set('lastUpdatedDate', _lastPollAt)

    const resp = await fetch(`${NMS_API_HOST}/v1/notams?${params.toString()}`, {
      headers: {
        'Authorization':     `Bearer ${token}`,
        'nmsResponseFormat': 'GEOJSON',
      },
    })
    if (!resp.ok) {
      console.warn(`[notam] NMS poll HTTP ${resp.status} (${wasBootstrap ? 'bootstrap' : 'delta'})`)
      return
    }

    // Small/filtered queries return inline JSON: {"status":...,"data":{"geojson":[...]}}.
    // Large/unfiltered ones (like our classification-only bootstrap query)
    // 307-redirect to /v1/content/{token}, which serves a raw gzip file with
    // NO Content-Encoding header (just Content-Disposition: attachment;
    // filename=...gz) -- fetch's automatic decompression never triggers, so
    // we must sniff the gzip magic bytes and decompress manually. That
    // content is ALSO a bare JSON array of features, not the {status,data}
    // envelope the inline responses use -- both must be handled here.
    const buf = Buffer.from(await resp.arrayBuffer())
    const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
    const text = isGzip ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
    const parsed = JSON.parse(text) as NmsGeoJsonFeature[] | NmsNotamsResponse
    const features = Array.isArray(parsed) ? parsed : (parsed.data?.geojson ?? [])
    let kept = 0
    for (const feature of features) {
      const n = feature.properties?.coreNOTAMData?.notam
      if (!n?.icaoLocation || !n.id) continue

      // Attach the sibling feature.geometry here -- it lives one level up
      // from properties.coreNOTAMData.notam in the raw response, so this is
      // the only point where both are in scope together. See NotamPolygon
      // handling in activeNotamsFor() for how Polygon/MultiPolygon geometry
      // gets surfaced; Point geometry is dropped (DMS coordinates+radius
      // fields already cover that case). Attached before the scope check
      // below since its geometry test needs it.
      n.geometry = feature.geometry ?? null

      if (!inIngestScope(n)) continue

      // Keyed by the location the NOTAM is filed under (an aerodrome or a
      // FIR). On a delta, a record moved to another location by an update is
      // dropped from its old key so it never shows twice (skipped on
      // bootstrap: the cache starts empty, and the scan is per record).
      if (!wasBootstrap) {
        for (const [key, other] of _cache) {
          if (key !== n.icaoLocation && key !== MILITARY_EU_KEY && other.delete(n.id) && other.size === 0) _cache.delete(key)
        }
      }
      let byId = _cache.get(n.icaoLocation)
      if (!byId) { byId = new Map(); _cache.set(n.icaoLocation, byId) }
      byId.set(n.id, n)
      kept++
    }

    const pruned = pruneCache()
    _lastPollAt = pollStartedAt
    // The cursor must be persisted even when nothing changed, but a full
    // rewrite of the Europe-wide file every 3 min is wasteful: write when
    // entries changed, else at most every CURSOR_SAVE_MS.
    if (kept > 0 || pruned > 0 || Date.now() - _lastSavedAt > CURSOR_SAVE_MS) saveCacheToDisk()
    console.log(`[notam] NMS poll OK (${wasBootstrap ? 'bootstrap' : 'delta'}): ${features.length} received, ${kept} kept (supported regions)`)
  } catch (e) {
    // Do not advance _lastPollAt on failure — next cycle retries the same
    // (or wider) window rather than silently skipping missed updates.
    console.warn('[notam] NMS poll failed:', (e as Error).message)
  }
}

/**
 * Second, independent poller for classification=MILITARY -- catches real
 * military exercise/training NOTAMs that classification=INTERNATIONAL
 * never includes. Motivating live example: a German Baltic-Sea NVG-
 * training NOTAM (M3011/26, icaoLocation=EDWW) was confirmed present in
 * NMS-API's data with classification="MIL", but pollOnce() above never
 * sees it -- classification=INTERNATIONAL and classification=MILITARY are
 * disjoint buckets from NMS-API's own perspective, not an overlap
 * pollOnce()'s existing query could be widened to cover.
 *
 * Deliberately NOT a delta/cursor design like pollOnce() -- the whole
 * classification=MILITARY worldwide dataset is small (~970KB gzipped /
 * 5,600 features measured on staging, ~8.5x smaller than the
 * classification=INTERNATIONAL pull), so a full re-fetch once per day is
 * cheap enough that tracking a lastUpdatedDate cursor would add complexity
 * for no real benefit. Each successful poll REPLACES the MILITARY_EU_KEY
 * bucket wholesale (not an incremental upsert) so cancelled/superseded
 * NOTAMs are naturally dropped without needing pruneCache()'s
 * effectiveEnd/cancelationDate logic to catch them first.
 *
 * Filtered with the same ingest scope as pollOnce() (inIngestScope():
 * every supported region by ICAO prefix or geometry), so civil and military
 * NOTAMs always cover the same countries.
 */
async function pollMilitaryOnce(): Promise<void> {
  if (!notamConfig.available) return

  try {
    const token = await getNmsToken()
    const resp = await fetch(`${NMS_API_HOST}/v1/notams?classification=MILITARY`, {
      headers: {
        'Authorization':     `Bearer ${token}`,
        'nmsResponseFormat': 'GEOJSON',
      },
    })
    if (!resp.ok) {
      // A 429 here almost always means the 1-bulk-pull-per-24h cap (e.g.
      // a restart after a successful pull earlier today, before this
      // timestamp was persisted). Do NOT retry soon -- that is exactly the
      // "more frequent use" the FAA says requires approval. The daily
      // timer (or next restart, now gated by _lastMilitaryPullAt) retries.
      console.warn(`[notam] NMS MILITARY poll HTTP ${resp.status} -- not retrying (1 bulk pull / 24h limit)`)
      return
    }

    // Same inline-JSON-vs-redirected-gzip handling as pollOnce() -- see its
    // own comment for why both shapes must be handled.
    const buf = Buffer.from(await resp.arrayBuffer())
    const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
    const text = isGzip ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
    const parsed = JSON.parse(text) as NmsGeoJsonFeature[] | NmsNotamsResponse
    const features = Array.isArray(parsed) ? parsed : (parsed.data?.geojson ?? [])

    const byId = new Map<string, NmsNotam>()
    for (const feature of features) {
      const n = feature.properties?.coreNOTAMData?.notam
      if (!n?.icaoLocation || !n.id) continue
      n.geometry = feature.geometry ?? null
      if (!inIngestScope(n)) continue
      byId.set(n.id, n)
    }

    // Wholesale replace, not merge -- see this function's own header for why.
    if (byId.size > 0) {
      _cache.set(MILITARY_EU_KEY, byId)
    _lastMilitaryPullAt = new Date().toISOString()
    } else {
      _cache.delete(MILITARY_EU_KEY)
    }

    pruneCache()
    saveCacheToDisk()
    console.log(`[notam] NMS MILITARY poll OK: ${features.length} received worldwide, ${byId.size} kept (supported regions)`)
  } catch (e) {
    console.warn('[notam] NMS MILITARY poll failed:', (e as Error).message)
  }
}

let _pollTimer: ReturnType<typeof setInterval> | null = null
let _militaryPollTimer: ReturnType<typeof setInterval> | null = null


/**
 * Called once at server boot. Starts the shared poller immediately if
 * credentials are configured (unlike the idle-gated traffic poller, this
 * one cadence is cheap — one request per ~3.3 min — and keeping the cache
 * warm matters more than saving that trivial call volume).
 */
export function startNotamPoller(): void {
  if (!notamConfig.available) {
    console.log('[notam] NMS_CLIENT_ID/NMS_CLIENT_SECRET not configured — NOTAM lookups disabled')
    return
  }
  loadCacheFromDisk()
  console.log(`[notam] NMS-API poller starting (host=${NMS_API_HOST}, interval=${POLL_INTERVAL_MS}ms)`)
  void pollOnce()
  _pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL_MS)
  _pollTimer.unref?.() // never keep the process alive solely for this timer

  // classification=MILITARY with no other filter is a FULL classification
  // pull, which NMS-API's production terms cap at ONE per 24 hours
  // account-wide ("1 bulk pull every 24 hours at most ... full
  // classification pulls of GeoJSON data"). That cap does not reset on
  // restart, so the last successful pull time is persisted with the cache
  // and the boot-time pull is deferred until the window has elapsed.
  // Confirmed live: a redeploy a few minutes after a successful pull
  // produced 429s on every subsequent restart that day.
  const sinceLastMs = _lastMilitaryPullAt ? Date.now() - Date.parse(_lastMilitaryPullAt) : Infinity
  const firstDelayMs = Math.max(0, MILITARY_POLL_INTERVAL_MS - sinceLastMs)
  console.log(`[notam] NMS-API MILITARY poller starting (interval=${MILITARY_POLL_INTERVAL_MS}ms, first pull in ${Math.round(firstDelayMs / 60000)} min -- last successful pull ${_lastMilitaryPullAt ?? 'never'})`)
  const kick = (): void => {
    void pollMilitaryOnce()
    _militaryPollTimer = setInterval(() => { void pollMilitaryOnce() }, MILITARY_POLL_INTERVAL_MS)
    _militaryPollTimer.unref?.()
  }
  if (firstDelayMs === 0) kick()
  else setTimeout(kick, firstDelayMs).unref?.()
}

export function stopNotamPoller(): void {
  if (_pollTimer) clearInterval(_pollTimer)
  _pollTimer = null
  if (_militaryPollTimer) clearInterval(_militaryPollTimer)
  _militaryPollTimer = null
}

/**
 * Read-only cache lookup for /api/notam?icao=. No network call, no
 * rate limiting needed here — the poller above is the only NMS-API client.
 * Filters to currently-active NOTAMs (not expired, not cancelled).
 */
function activeNotamsFor(icao: string): NotamItem[] {
  const byId = _cache.get(icao)
  return byId ? activeItems(byId.values()) : []
}

/** Raw cache records -> currently-active client NotamItems. */
function activeItems(raw: Iterable<NmsNotam>): NotamItem[] {
  const now = Date.now()
  const notams: NotamItem[] = []
  for (const n of raw) {
    if (n.cancelationDate && Date.parse(n.cancelationDate) <= now) continue
    if (n.effectiveEnd && Date.parse(n.effectiveEnd) < now) continue
    if (n.effectiveStart && Date.parse(n.effectiveStart) > now) continue
    const geo = parseNotamCoordinates(n.coordinates)
    const radiusNm = n.radius !== undefined ? Number(n.radius) : NaN
    const text = (n.text ?? '').replace(/\r\n/g, '\n').trim()
    const qCode = qCodeFor(n)
    if (isChecklist(n, qCode)) continue
    // Cancellation messages (NOTAMC) carry no operational content of their
    // own -- they only announce that another NOTAM is gone, which the
    // cancelled NOTAM's own cancelationDate already reflects. Shown as a list
    // entry they read like an active notice ("V0828/26 NOTAMC V0818/26").
    if (str(n.type) === 'C' || /^\s*\S+\s+NOTAMC\b/.test(text)) continue

    // NMS-API uses radius="999" (and presumably similar round-number
    // sentinels) as a placeholder for non-geographic administrative NOTAMs
    // -- confirmed live in production: a "NOTAM Checklist" cross-reference
    // (text literally starting "CHECKLIST", just a list of currently-valid
    // NOTAM numbers for the whole FIR, not an area restriction) came back
    // with radius=999 and a coordinate that isn't a meaningful location
    // either, rendering as one giant circle spanning most of Scandinavia.
    // Real Swedish restricted/danger/exercise areas topped out at 33nm in
    // every live sample seen so far (see notam.ts's coordinate-parsing
    // comment above) -- 100nm is a generous, conservative ceiling clear of
    // any real area but well below any "unlimited"-style sentinel value.
    // Drop BOTH lat/lon and radiusNm together (not just radius) when this
    // trips -- the coordinate isn't meaningfully tied to the NOTAM's actual
    // subject either, so a point-marker pin would be just as misleading as
    // the giant circle. These NOTAMs still appear in the regional NOTAMs
    // list panel (text-only), just not rendered on the map at all.
    // Three cases:
    //  - no radius field / not finite / <=0  -> legitimate point-only NOTAM
    //    (obstacle lights, single-point navaid faults) -- keep lat/lon,
    //    radiusNm null. This is the normal, common case -- do NOT drop the
    //    coordinate here, that would silently break point-marker rendering.
    //  - radius present, 0 < r <= 100nm       -> legitimate area -- keep all three.
    //  - radius present but > 100nm            -> sentinel/bogus -- drop
    //    lat/lon AND radiusNm together (see comment above).
    // MAX_SANE_RADIUS_NM is module-scoped (see top of file).
    const radiusGiven = Number.isFinite(radiusNm) && radiusNm > 0
    const radiusIsBogus = radiusGiven && radiusNm > MAX_SANE_RADIUS_NM

    const polygon = extractNotamPolygon(n.geometry)

    notams.push({
      id:             n.number ?? n.id ?? '',
      // NMS-API's own globally-unique internal id -- NOT the same as `id`
      // above, which is the human-readable published NOTAM number
      // ("M3011/26"-style). Confirmed live and real, not hypothetical:
      // different issuing authorities reuse the same series+number+year --
      // a German (EDWW) and an Italian (Amendola CTR) NOTAM both published
      // as "M3011/26" coexisted in the same poll. Dedup keyed on the
      // display `id` alone (as getRegionalNotams() used to do) silently
      // drops one of them, believing it's a duplicate. `nmsId` exists
      // purely so callers can dedupe correctly without that collision --
      // not meant for display.
      nmsId:          n.id ?? '',
      text,
      effective:      n.effectiveStart ?? null,
      expires:        n.effectiveEnd ?? null,
      classification: n.classification ?? null,
      // Already used extensively server-side (cache keying, scope/
      // cross-border filtering) but previously dropped at this exact
      // construction site -- clients had no "where" for a NOTAM at all
      // short of parsing it out of the free-text `text` field themselves.
      icaoLocation:   n.icaoLocation ?? null,
      qCode,
      affectedFir:    str(n.affectedFir),
      // ICAO convention: Q-line radius 999 = the entire FIR.
      firWide:        !polygon && radiusGiven && radiusNm >= 999,
      icao:           icaoFieldsFor(n),
      polygon,
      // Polygon geometry (real, structured, from NMS-API itself) takes
      // priority over the synthesized DMS point/circle fields when both
      // would otherwise apply -- an actual multi-vertex area shape is
      // strictly more accurate than a single-point circle approximation of
      // the same NOTAM. The radius=999-style sentinel/bogus check above only
      // ever applied to the circle path; a real Polygon is never subject to
      // it since it isn't derived from a radius field at all.
      lat:            polygon ? null : (geo && !radiusIsBogus ? geo.lat : null),
      lon:            polygon ? null : (geo && !radiusIsBogus ? geo.lon : null),
      radiusNm:       polygon ? null : (geo && radiusGiven && !radiusIsBogus ? radiusNm : null),
    })
  }
  return notams
}

export function getNotamsForIcao(icao: string): NotamResponse {
  return { notams: activeNotamsFor(icao) }
}

/**
 * Bulk per-aerodrome NOTAM texts (active only), one lookup for EVERY airport
 * ICAO in the requested regions at once -- purely an in-memory cache read (same
 * cost profile as getNotamsForIcao/getRegionalNotams above, no NMS-API call
 * at request time), so no per-user rate limit is needed here either. Built
 * for the map's "towered airport ATC status ring" feature: rather than the
 * client looping one /api/notam?icao=X request per towered airport on its
 * own refresh interval (unnecessary request fan-out for data this endpoint
 * can return in one shot), it fetches this once and applies its own
 * keyword-based ATC-closed / hours-changed heuristics client-side (see
 * @open-vfr/shared/atcStatus) -- text only, never a definitive status here.
 * FIR-level NOTAMs (filed under the FIR itself, e.g. ESAA) are excluded --
 * those aren't tied to a single airport ICAO and are served separately via
 * getRegionalNotams()/`/api/notam/regional`.
 */
export function getAerodromeNotamTexts(regions: string[]): Record<string, string[]> {
  const { prefixes } = regionScope(regions)
  const out: Record<string, string[]> = {}
  for (const [icao, byId] of _cache) {
    if (icao === MILITARY_EU_KEY || !prefixes.has(icao.slice(0, 2))) continue
    const raw = [...byId.values()].filter((n) => str(n.affectedFir)?.toUpperCase() !== icao)
    const texts = activeItems(raw).map((n) => n.text).filter(Boolean)
    if (texts.length > 0) out[icao] = texts
  }
  return out
}

/**
 * Regional NOTAMs for the given regions -- restricted/danger areas, navaid
 * outages, AIRAC amendments, military exercise notices, etc. that aren't
 * about a single airport (see isRegional()), plus every MILITARY NOTAM.
 * Scoped with notamInRegions(): filed in one of the regions, or geometry
 * reaching into one (cross-border areas). The cache itself covers every
 * supported region; this never returns the whole of it.
 */
export function getRegionalNotams(regions: string[]): NotamResponse {
  const scope = regionScope(regions)
  const notams: NotamItem[] = []
  // Dedup on nmsId (NMS-API's own globally-unique internal id), NOT the
  // display `id` (published NOTAM number) -- confirmed live and real that
  // different issuing authorities reuse the same series+number+year (a
  // German EDWW NOTAM and an unrelated Italian one were both "M3011/26").
  // Deduping on the display id alone silently drops one of them. This
  // fixed a real bug found via verification: before this fix, exactly that
  // collision made getRegionalNotams() return only 1 of 2 real, unrelated
  // NOTAMs sharing that number.
  const seen = new Set<string>()
  for (const [key, byId] of _cache) {
    const military = key === MILITARY_EU_KEY
    const raw = [...byId.values()].filter((n) => (military || isRegional(n)) && notamInRegions(scopeInputFor(n), scope))
    for (const n of activeItems(raw)) {
      if (seen.has(n.nmsId)) continue // e.g. the same record in the MILITARY and INTERNATIONAL pulls
      seen.add(n.nmsId)
      notams.push(n)
    }
  }
  return { notams }
}
