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
 * docs/nms/FAQ NMS-API.pdf in openvfr-infra, "What is the rate limit?".)
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
 *    in-memory down to Swedish ICAOs (from aerodrome-coords.json). We
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

export interface NotamItem {
  id:             string
  text:           string
  effective:      string | null
  expires:        string | null
  classification: string | null
  // Geo fields, present only when NMS-API supplied a coordinates+radius pair
  // (parsed from DMS strings like "5939N01756E" + radius in NM) -- used to
  // render an ad-hoc circle for NOTAMs that don't correspond to a charted
  // airspace polygon (e.g. temporary restricted/danger areas established
  // mid-AIRAC-cycle). null when absent, e.g. purely textual NOTAMs.
  lat:      number | null
  lon:      number | null
  radiusNm: number | null
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

export const notamConfig = {
  available: Boolean(NMS_CLIENT_ID && NMS_CLIENT_SECRET),
}

// ── Swedish ICAO allow-list (from the same static snapshot the legacy code
// used for lat/lon) — NMS-API's classification query has no location filter
// usable at this scale, so we pull worldwide INTERNATIONAL NOTAMs and keep
// only the ones for airports this app actually covers. ─────────────────────
//
// ALSO includes ESAA (the Sweden FIR code) -- NOTAMs are not only filed per
// airport. Restricted/danger areas, DME/navaid outages not tied to a single
// aerodrome, AIRAC AIP amendment notices, and military exercise-hour changes
// are all filed with icaoLocation=ESAA (the whole-country FIR), not any
// airport ICAO. Confirmed against live staging data: 34 currently-active
// NOTAMs (temporary restricted areas like ESR448/ESR374/ESR738/ESR525,
// danger areas like ESD873/ESD139, DME outages, AIRAC amendments) were
// being silently dropped entirely before ESAA was added here -- not just
// undisplayed, actually never cached at all. See getRegionalNotams() below
// for how these are surfaced (kept separate from per-airport results since
// they don't belong to any single ICAO).
// Per-country FIR codes for regional (non-airport) NOTAMs. One country can
// have MULTIPLE FIRs (e.g. Germany: EDMM/EDWW/EDUU/EDVV) -- deliberately a
// country -> string[] map, not one flat list, so adding a country later is
// "add an entry", not "restructure this". Add a country's FIR(s) here ONLY
// once its aerodromes/airspace actually exist in the tile pipeline
// (openvfr-infra's scripts/prepare-tiles.sh is currently Sweden-only -- see
// its own "TODO (Phase 2)" comments).
const FIR_CODES: Record<string, string[]> = {
  SE: ['ESAA'], // Sweden -- single FIR
}
const _regionalKeys = Object.values(FIR_CODES).flat()

const _icaoAllowlist = new Set<string>(_regionalKeys)
try {
  const coordsJson = (await import('./aerodrome-coords.json', { assert: { type: 'json' } })).default as Record<string, [number, number]>
  for (const icao of Object.keys(coordsJson)) _icaoAllowlist.add(icao)
  console.log(`[notam] Loaded ${_icaoAllowlist.size} ICAOs for NOTAM filtering (${_icaoAllowlist.size - _regionalKeys.length} aerodromes + FIRs: ${_regionalKeys.join(', ')})`)
} catch (e) {
  console.warn('[notam] Could not load aerodrome coords:', (e as Error).message)
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
  cancelationDate?: string
  coordinates?:     string // DMS, e.g. "5939N01756E" (lat DDMM + N/S, lon DDDMM + E/W)
  radius?:          string // nautical miles, e.g. "5"
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
interface NmsGeoJsonFeature {
  properties?: { coreNOTAMData?: { notam?: NmsNotam } }
}
interface NmsNotamsResponse {
  data?: { geojson?: NmsGeoJsonFeature[] }
}

// ── Shared cache: icaoLocation -> (notam id -> raw NMS record) ─────────────
const _cache = new Map<string, Map<string, NmsNotam>>()
let _lastPollAt: string | null = null // ISO timestamp of last successful poll start

// Grace period past effectiveEnd/cancelationDate before an entry is pruned
// from the cache entirely (not just excluded from getNotamsForIcao's active-
// window filter). Keeps the persisted file/memory footprint from growing
// unboundedly as NOTAMs get superseded/cancelled over time, while still
// tolerant of minor clock skew vs. NMS's own timestamps.
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000

interface PersistedCache {
  apiHost:    string // NMS_API_HOST this cache was populated from -- see loadCacheFromDisk()
  lastPollAt: string | null
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

    for (const [icao, idEntries] of parsed.entries) _cache.set(icao, new Map(idEntries))
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
      apiHost:    NMS_API_HOST,
      lastPollAt: _lastPollAt,
      entries: [..._cache.entries()].map(([icao, byId]) => [icao, [...byId.entries()]]),
    }
    writeFileSync(NMS_CACHE_FILE, JSON.stringify(payload))
  } catch (e) {
    // Non-fatal -- worst case, next restart re-bootstraps instead of
    // warm-starting. Don't let a read-only/missing volume crash the poller.
    console.warn('[notam] Failed to persist disk cache:', (e as Error).message)
  }
}

// Drop entries that are long past relevance so the cache/file don't grow
// forever. Cheap to run every poll cycle given the small (Sweden-scale) size.
function pruneCache(): void {
  const cutoff = Date.now() - PRUNE_GRACE_MS
  for (const [icao, byId] of _cache) {
    for (const [id, n] of byId) {
      const cancelled = n.cancelationDate && Date.parse(n.cancelationDate) <= cutoff
      const expired   = n.effectiveEnd && Date.parse(n.effectiveEnd) < cutoff
      if (cancelled || expired) byId.delete(id)
    }
    if (byId.size === 0) _cache.delete(icao)
  }
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
      if (!_icaoAllowlist.has(n.icaoLocation)) continue

      let byId = _cache.get(n.icaoLocation)
      if (!byId) { byId = new Map(); _cache.set(n.icaoLocation, byId) }
      byId.set(n.id, n)
      kept++
    }

    pruneCache()
    _lastPollAt = pollStartedAt
    saveCacheToDisk()
    console.log(`[notam] NMS poll OK (${wasBootstrap ? 'bootstrap' : 'delta'}): ${features.length} received, ${kept} kept for tracked ICAOs`)
  } catch (e) {
    // Do not advance _lastPollAt on failure — next cycle retries the same
    // (or wider) window rather than silently skipping missed updates.
    console.warn('[notam] NMS poll failed:', (e as Error).message)
  }
}

let _pollTimer: ReturnType<typeof setInterval> | null = null

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
}

export function stopNotamPoller(): void {
  if (_pollTimer) clearInterval(_pollTimer)
  _pollTimer = null
}

/**
 * Read-only cache lookup for /api/notam?icao=. No network call, no
 * rate limiting needed here — the poller above is the only NMS-API client.
 * Filters to currently-active NOTAMs (not expired, not cancelled).
 */
function activeNotamsFor(icao: string): NotamItem[] {
  const byId = _cache.get(icao)
  if (!byId) return []

  const now = Date.now()
  const notams: NotamItem[] = []
  for (const n of byId.values()) {
    if (n.cancelationDate && Date.parse(n.cancelationDate) <= now) continue
    if (n.effectiveEnd && Date.parse(n.effectiveEnd) < now) continue
    if (n.effectiveStart && Date.parse(n.effectiveStart) > now) continue
    const geo = parseNotamCoordinates(n.coordinates)
    const radiusNm = n.radius !== undefined ? Number(n.radius) : NaN
    notams.push({
      id:             n.number ?? n.id ?? '',
      text:           (n.text ?? '').replace(/\r\n/g, '\n').trim(),
      effective:      n.effectiveStart ?? null,
      expires:        n.effectiveEnd ?? null,
      classification: n.classification ?? null,
      lat:            geo?.lat ?? null,
      lon:            geo?.lon ?? null,
      radiusNm:       geo && Number.isFinite(radiusNm) ? radiusNm : null,
    })
  }
  return notams
}

export function getNotamsForIcao(icao: string): NotamResponse {
  return { notams: activeNotamsFor(icao) }
}

/**
 * FIR-wide/regional NOTAMs (icaoLocation=ESAA) -- restricted/danger areas,
 * navaid outages, AIRAC amendments, military exercise notices, etc. that
 * aren't filed against any single airport. NOT returned by
 * getNotamsForIcao() for any airport ICAO -- these live under their own key
 * (their FIR code, e.g. 'ESAA') in the cache, separate from per-airport
 * results. Aggregates across every FIR in FIR_CODES -- currently just
 * Sweden's, but scales to however many countries/FIRs are configured there
 * without further changes here.
 */
export function getRegionalNotams(): NotamResponse {
  const notams: NotamItem[] = []
  const seen = new Set<string>()
  for (const fir of _regionalKeys) {
    for (const n of activeNotamsFor(fir)) {
      if (seen.has(n.id)) continue // a NOTAM could in principle appear under >1 FIR key
      seen.add(n.id)
      notams.push(n)
    }
  }
  return { notams }
}
