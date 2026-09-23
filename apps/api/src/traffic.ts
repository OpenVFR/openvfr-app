/**
 * server/src/traffic.ts
 *
 * OpenSky Network traffic poller + SSE broadcaster (Option A).
 *
 * Design:
 *  - One server-side OAuth2 token (client_credentials flow) shared globally.
 *  - One bounding-box poll per OPENSKY_POLL_INTERVAL_S (default 65 s) for
 *    the whole configured region — credit cost 3–4/call, ONE call serves any
 *    number of connected clients (broadcast fans out, does not multiply calls).
 *  - All connected browser SSE clients receive the same batch update.
 *  - Clients dead-reckon positions at 1 s intervals between polls.
 *
 *  - IDLE GATING: the poll loop only runs while at least one consumer is
 *    active — an open SSE connection (web), or a native `/api/traffic/latest`
 *    request within the last IDLE_TIMEOUT_MS. With zero consumers the loop
 *    stops rescheduling itself after its current cycle and goes to sleep;
 *    the next consumer touch (SSE connect or `/latest` request) restarts it
 *    immediately. Without this, the poller ran forever from server boot
 *    regardless of usage, burning the shared OpenSky account's daily credit
 *    quota 24/7 even overnight with zero users connected.
 *
 * Required env vars (optional — traffic disabled if unset):
 *   OPENSKY_CLIENT_ID      OAuth2 client ID from opensky-network.org account
 *   OPENSKY_CLIENT_SECRET  OAuth2 client secret
 *   OPENSKY_BBOX           lat_min,lon_min,lat_max,lon_max  (default: Sweden)
 *   OPENSKY_POLL_INTERVAL_S  seconds between polls — explicit override.
 *                            If unset, computed automatically from
 *                            OPENSKY_DAILY_CREDITS and the bbox credit cost
 *                            (see computeDefaultIntervalS() below).
 *   OPENSKY_DAILY_CREDITS  account's daily credit quota (default: 4,000 —
 *                          the standard registered-account limit). OpenSky
 *                          DOUBLES this to 8,000/day per actively-feeding
 *                          ADS-B receiver linked to the account (see
 *                          https://opensky-network.org/data/data-sharing).
 *                          Set to 8000 (one feeder), 12000 (two), etc. once
 *                          feeding — the default poll interval halves
 *                          automatically to spend the extra budget on
 *                          fresher traffic instead of leaving it unused.
 *
 * Credit math (auto-computed, not hardcoded — see computeDefaultIntervalS()):
 *   Sweden bbox ≈ 182 sq° → 3 credits/call
 *   Full-Europe bbox ≈ 4,200 sq° → 4 credits/call
 *   4,000 credits/day ÷ 3/call → 1,333 calls/day → ~65 s interval
 *   8,000 credits/day (1 feeder) ÷ 3/call → 2,667 calls/day → ~32 s interval
 *   (idle gating above means actual usage is normally far below this ceiling)
 *
 * OpenSky state vector index reference (array positions):
 *   0  icao24        string
 *   1  callsign      string | null
 *   2  origin_country string
 *   3  time_position  int | null
 *   4  last_contact   int | null
 *   5  longitude      float | null
 *   6  latitude       float | null
 *   7  baro_altitude  float | null  (metres)
 *   8  on_ground      boolean
 *   9  velocity       float | null  (m/s)
 *  10  true_track     float | null  (degrees clockwise from north)
 *  11  vertical_rate  float | null  (m/s, positive = climbing)
 *  12  sensors        int[] | null
 *  13  geo_altitude   float | null  (metres)
 *  14  squawk         string | null
 *  15  spi            boolean
 *  16  position_source int
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrafficState {
  /** ICAO 24-bit transponder address (hex, lowercase). */
  icao24:       string
  callsign:     string | null
  /** Latitude degrees WGS-84. Null if no recent position. */
  lat:          number | null
  /** Longitude degrees WGS-84. Null if no recent position. */
  lon:          number | null
  /** Barometric altitude metres. Null if unknown. */
  altM:         number | null
  /** Ground speed m/s. Null if unknown. */
  velocityMs:   number | null
  /** True track degrees clockwise from north. Null if unknown. */
  trackDeg:     number | null
  /** Vertical rate m/s (+climb, −descend). Null if unknown. */
  vertRateMs:   number | null
  /** Whether the transponder reports the aircraft is on the ground. */
  onGround:     boolean
  /** Unix timestamp (seconds) of last OpenSky position update. */
  lastContact:  number | null
  /**
   * ICAO ADS-B emitter category (state vector index 17).
   * 0=no info  1=light  2=small  3=large  4=HVL/B757  5=heavy
   * 6=high-perf  7=rotorcraft  8=glider  9=LTA  10=parachutist
   * 11=ultralight  12=reserved  13=UAV  14=space  15-19=surface/obstacle
   *
   * OGN targets are mapped onto this same enum from FLARM's own aircraft-type
   * nibble (see ognTraffic.ts) so client icon/UI code needs zero source-aware
   * branching — a glider is category 8 whether it came from an ADS-B
   * transponder or a FLARM/OGN tracker.
   */
  category:     number | null
  /** Which upstream feed this target came from. See docs/architecture.md — combined, never one-replaces-the-other. */
  source:       'opensky' | 'ogn'
}

export interface TrafficBatch {
  /** Unix timestamp (seconds) when the OpenSky poll was made. */
  polledAt: number
  states:   TrafficState[]
}

export interface TrafficConfig {
  available:    boolean
  bbox:         [number, number, number, number] | null   // [latMin, lonMin, latMax, lonMax]
  intervalS:    number
  /** Whether the OGN (Open Glider Network) APRS-IS feed is enabled (see ognTraffic.ts). Always free/unmetered -- no credential gate like OpenSky. */
  ognAvailable: boolean
}

// ── Config ────────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env['OPENSKY_CLIENT_ID']     ?? ''
const CLIENT_SECRET = process.env['OPENSKY_CLIENT_SECRET'] ?? ''

// Parse bbox from env — four comma-separated floats.  Default = Sweden.
function parseBbox(raw: string): [number, number, number, number] {
  const parts = raw.split(',').map(Number)
  if (parts.length === 4 && parts.every(isFinite)) {
    return parts as [number, number, number, number]
  }
  // Default: Sweden bounding box (approx 182 sq°)
  return [55.0, 10.0, 69.5, 24.5]
}

// Exported: ognTraffic.ts derives its default APRS-IS filter centre/radius
// from this same region instead of duplicating a second bbox config -- one
// area covers both feeds unless OGN_FILTER_LAT/LON/RADIUS_KM overrides it.
export const BBOX   = parseBbox(process.env['OPENSKY_BBOX'] ?? '')

/** Credits per /states/all call: area(sq deg) <= 25 -> 1, <= 100 -> 2, <= 400 -> 3, else 4. */
function bboxCreditCost(bbox: [number, number, number, number]): number {
  const [latMin, lonMin, latMax, lonMax] = bbox
  const areaSqDeg = Math.max(0, latMax - latMin) * Math.max(0, lonMax - lonMin)
  if (areaSqDeg <= 25) return 1
  if (areaSqDeg <= 100) return 2
  if (areaSqDeg <= 400) return 3
  return 4
}

/**
 * Compute the default poll interval so that continuous polling spends the
 * full configured daily credit budget (with a small safety margin) instead
 * of leaving unused headroom on the table — e.g. once a feeder receiver
 * doubles the account's quota, the interval should automatically shrink to
 * take advantage of it.
 */
function computeDefaultIntervalS(dailyCredits: number, bbox: [number, number, number, number]): number {
  const creditCost = bboxCreditCost(bbox)
  const SAFETY_MARGIN = 0.97  // stay just under the ceiling, matches prior manual math
  const maxCallsPerDay = (dailyCredits * SAFETY_MARGIN) / creditCost
  const secondsPerDay = 86_400
  return Math.max(30, Math.ceil(secondsPerDay / maxCallsPerDay))
}

const DAILY_CREDITS = Math.max(1, parseInt(process.env['OPENSKY_DAILY_CREDITS'] ?? '4000', 10))

const INTERVAL_S    = Math.max(
  30,
  parseInt(
    process.env['OPENSKY_POLL_INTERVAL_S'] ?? String(computeDefaultIntervalS(DAILY_CREDITS, BBOX)),
    10,
  ),
)

const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all'

// ── Token manager ─────────────────────────────────────────────────────────────

let _token: string | null = null
let _tokenExpiresAt = 0  // unix ms

async function getToken(): Promise<string> {
  const now = Date.now()
  // Refresh if missing or within 60 s of expiry
  if (_token && now < _tokenExpiresAt - 60_000) return _token

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })

  const res = await fetch(OPENSKY_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`OpenSky token request failed: ${res.status} ${text.slice(0, 200)}`)
  }

  const data = await res.json() as { access_token: string; expires_in: number }
  _token = data.access_token
  _tokenExpiresAt = now + (data.expires_in ?? 1800) * 1000
  return _token
}

// ── SSE client registry ───────────────────────────────────────────────────────

type SseWriter = (data: string) => void

const _clients = new Set<SseWriter>()

export function registerClient(write: SseWriter): () => void {
  _clients.add(write)
  touchActivity()
  // Immediately send the latest batch if we have one
  if (_lastBatch) {
    try { write(JSON.stringify(_lastBatch)) } catch { /* client gone */ }
  }
  return () => { _clients.delete(write) }
}

function broadcast(batch: TrafficBatch): void {
  const payload = JSON.stringify(batch)
  for (const write of _clients) {
    try { write(payload) } catch { _clients.delete(write) }
  }
}

// ── Activity tracking (idle gating) ──────────────────────────────────────────
//
// The poll loop only runs while at least one consumer is "active":
//   - web: an open SSE connection (tracked via _clients.size)
//   - native: a `/api/traffic/latest` request within the last IDLE_TIMEOUT_MS
//     (native has no persistent connection — it's a plain polling GET every
//     ~70 s — so a recent request is treated as a live consumer heartbeat)
//
// touchActivity() must be called from both registerClient() and the
// `/api/traffic/latest` route handler.

const IDLE_TIMEOUT_MS = 90_000  // slightly above native's 70 s poll interval

let _lastActivityAt = 0

export function touchActivity(): void {
  _lastActivityAt = Date.now()
  ensurePolling()
}

/** Exported: ognTraffic.ts's own idle watcher gates its persistent APRS-IS
 *  socket on the same signal, so OGN connects/disconnects in step with
 *  whether anyone is actually looking at the traffic layer. */
export function hasActiveConsumers(): boolean {
  if (_clients.size > 0) return true
  return Date.now() - _lastActivityAt < IDLE_TIMEOUT_MS
}

// ── State ─────────────────────────────────────────────────────────────────────

export function getLatestBatch(): TrafficBatch | null {
  return _lastBatch
}

let _lastBatch: TrafficBatch | null = null
let _pollTimer: ReturnType<typeof setTimeout> | null = null
let _polling = false

/** Latest OpenSky states from the most recent poll (source of truth for the ADS-B half of the merge). */
let _openskyStates: TrafficState[] = []

/**
 * Latest per-target OGN state, keyed by TrafficState.icao24. Updated
 * per-packet by ognTraffic.ts (updateOgnState()) as APRS-IS messages arrive —
 * cheap map writes, no broadcast on every packet. A separate ticker
 * (pruneAndBroadcastOgn(), driven by ognTraffic.ts) periodically prunes stale
 * entries and triggers a merged rebroadcast, decoupling OGN's much higher
 * message rate from the SSE fan-out cadence.
 */
const _ognStates = new Map<string, TrafficState>()

/**
 * Union OpenSky + OGN into one broadcast batch, deduped by icao24.
 *
 * Dedup rule: if the SAME icao24 is reported by both feeds (this only
 * happens for OGN targets whose FLARM/OGN-tracker "id" field carries
 * address-type=ICAO — see ognTraffic.ts), prefer OpenSky's own state. Both
 * ultimately describe the same aircraft's ADS-B-derived position; OpenSky's
 * feed is the canonical one for anything transponder-equipped. Targets only
 * OGN can see (gliders, tow planes, many ultralights without ADS-B) pass
 * through union'd in, tagged source:'ogn'.
 */
function recomputeAndBroadcast(): void {
  const openskyIcaos = new Set(_openskyStates.map(s => s.icao24.toLowerCase()))
  const merged: TrafficState[] = [..._openskyStates]
  for (const s of _ognStates.values()) {
    if (openskyIcaos.has(s.icao24.toLowerCase())) continue
    merged.push(s)
  }
  _lastBatch = { polledAt: Math.floor(Date.now() / 1000), states: merged }
  broadcast(_lastBatch)
}

/** Called by ognTraffic.ts on every parsed APRS-IS aircraft beacon. Map write only — no broadcast per packet. */
export function updateOgnState(state: TrafficState): void {
  _ognStates.set(state.icao24, state)
}

/** Called periodically by ognTraffic.ts (independent of OpenSky's ~65 s poll cycle) to prune stale OGN targets and push a merged rebroadcast at OGN's own, much faster, cadence. */
export function pruneAndBroadcastOgn(staleS: number): void {
  const nowS = Date.now() / 1000
  for (const [k, v] of _ognStates) {
    if (v.lastContact != null && nowS - v.lastContact > staleS) _ognStates.delete(k)
  }
  recomputeAndBroadcast()
}

// ── Poller ────────────────────────────────────────────────────────────────────

async function poll(): Promise<number> {
  try {
    const token = await getToken()
    const [latMin, lonMin, latMax, lonMax] = BBOX
    const url = `${OPENSKY_STATES_URL}?lamin=${latMin}&lomin=${lonMin}&lamax=${latMax}&lomax=${lonMax}`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('X-Rate-Limit-Retry-After-Seconds') ?? '120', 10)
      console.warn(`[traffic] Rate limited — backing off ${retryAfter} s`)
      return retryAfter * 1000
    }

    if (!res.ok) {
      console.error(`[traffic] Poll failed: ${res.status}`)
      return INTERVAL_S * 1000
    }

    const json = await res.json() as { time: number; states: unknown[][] | null }
    const polledAt = json.time ?? Math.floor(Date.now() / 1000)
    const rawStates = json.states ?? []

    const states: TrafficState[] = rawStates
      .filter((s): s is unknown[] => Array.isArray(s))
      .filter(s => s[5] != null && s[6] != null)  // must have lat/lon
      .map(s => ({
        icao24:      String(s[0] ?? ''),
        callsign:    s[1] != null ? String(s[1]).trim() || null : null,
        lat:         typeof s[6] === 'number' ? s[6] : null,
        lon:         typeof s[5] === 'number' ? s[5] : null,
        altM:        typeof s[7] === 'number' ? s[7] : null,
        velocityMs:  typeof s[9] === 'number' ? s[9] : null,
        trackDeg:    typeof s[10] === 'number' ? s[10] : null,
        vertRateMs:  typeof s[11] === 'number' ? s[11] : null,
        onGround:    Boolean(s[8]),
        lastContact: typeof s[4] === 'number' ? s[4] : null,
        category:    typeof s[17] === 'number' ? s[17] : null,
        source:      'opensky' as const,
      }))

    _openskyStates = states
    recomputeAndBroadcast()
    console.log(`[traffic] Polled ${states.length} OpenSky targets (+${_ognStates.size} OGN), broadcast to ${_clients.size} clients`)
    return INTERVAL_S * 1000

  } catch (err) {
    console.error('[traffic] Poll error:', err instanceof Error ? err.message : String(err))
    return INTERVAL_S * 1000
  }
}

function schedulePoll(): void {
  poll().then(delayMs => {
    // Idle gating: if no consumer has been active recently, stop rescheduling
    // and go to sleep. The next registerClient() (SSE connect) or
    // touchActivity() (native /latest request) call restarts the loop via
    // ensurePolling(). Without this the poller ran forever from server boot
    // regardless of usage, burning OpenSky credits 24/7 with 0 clients.
    if (!hasActiveConsumers()) {
      console.log('[traffic] No active consumers — poller going idle')
      _polling = false
      _pollTimer = null
      return
    }
    _pollTimer = setTimeout(schedulePoll, delayMs)
  })
}

/** (Re)start the poll loop if it isn't already running. Safe to call repeatedly. */
function ensurePolling(): void {
  if (!CLIENT_ID || !CLIENT_SECRET) return  // no-op if credentials unset
  if (_polling) return  // already running
  _polling = true
  console.log(`[traffic] Consumer activity detected — starting poller: bbox=${JSON.stringify(BBOX)}, interval=${INTERVAL_S}s, dailyCredits=${DAILY_CREDITS}, creditCost/call=${bboxCreditCost(BBOX)}`)
  schedulePoll()
}

// ── Public API ────────────────────────────────────────────────────────────────

export const trafficConfig: TrafficConfig = {
  available:    Boolean(CLIENT_ID && CLIENT_SECRET),
  bbox:         Boolean(CLIENT_ID && CLIENT_SECRET) ? BBOX : null,
  intervalS:    INTERVAL_S,
  // No credential gate -- OGN's APRS-IS feed is free/unmetered by design.
  // Only an explicit opt-out disables it (self-hosters without outbound
  // access to aprs.glidernet.org:14580, or who simply don't want it).
  ognAvailable: process.env['OGN_ENABLED'] !== 'false',
}

/**
 * Called once at server boot. Does NOT start polling immediately — only logs
 * whether traffic is configured. The poll loop itself is idle-gated and only
 * starts when a real consumer shows up (see registerClient()/touchActivity()
 * + ensurePolling() above), so an idle server with credentials configured
 * still burns zero OpenSky credits until someone actually opens the map.
 */
export function startTrafficPoller(): void {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('[traffic] No credentials configured — traffic poller disabled')
    return
  }
  console.log('[traffic] Credentials configured — poller will start on first consumer activity (idle-gated)')
}
