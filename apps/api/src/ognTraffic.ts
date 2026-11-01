/**
 * server/src/ognTraffic.ts
 *
 * OGN (Open Glider Network) APRS-IS relay — second, always-free traffic
 * feed, unioned with OpenSky (traffic.ts) rather than replacing it.
 *
 * Why a second feed instead of picking one: OpenSky (global ADS-B —
 * airliners, transponder-equipped GA) and OGN (FLARM/glider network —
 * gliders, tow planes, many ultralights *without* ADS-B) cover largely
 * non-overlapping traffic populations. Union'd + deduped in traffic.ts.
 *
 * Design (persistent socket, not poll-and-quota — mirrors OpenSky's SSE
 * fan-out shape but the upstream side is fundamentally different):
 *  - APRS-IS has no request quota, no credits, no per-account budget — it's
 *    one long-lived TCP connection that the server holds open and the
 *    network pushes position reports down as they happen.
 *  - A server-side geographic filter is baked into the login line itself
 *    (`filter a/north/west/south/east`, the OPENSKY_BBOX area, or
 *    `filter r/lat/lon/radius_km` when overridden) so aprs.glidernet.org
 *    only sends packets for the configured region — no full-network firehose, no
 *    client-side geo filtering needed.
 *  - Idle-gated exactly like OpenSky's poller: the socket only connects
 *    while hasActiveConsumers() is true (an open web SSE connection, or a
 *    native /latest request within the last 90 s — see traffic.ts). A
 *    watcher tick checks this every OGN_IDLE_CHECK_MS and connects/
 *    disconnects accordingly, so an idle server holds zero sockets open.
 *  - Per-packet updates go straight into traffic.ts's in-memory map
 *    (updateOgnState() — cheap, no broadcast). A separate ticker
 *    (OGN_BROADCAST_INTERVAL_MS) prunes stale targets and pushes one merged
 *    rebroadcast at a time, decoupling OGN's much higher per-second message
 *    rate from the SSE fan-out cadence — broadcasting on every individual
 *    APRS packet would flood every connected browser tab.
 *
 * Env vars (all optional):
 *   OGN_ENABLED            'false' to disable entirely (default: enabled)
 *   OGN_FILTER_LAT/LON     APRS-IS circle filter centre. Unset (default): the
 *                          whole OPENSKY_BBOX rectangle is used instead.
 *   OGN_FILTER_RADIUS_KM   circle radius, km (default 350; only used with
 *                          OGN_FILTER_LAT/LON)
 *   OGN_APRS_HOST/PORT     APRS-IS server (default: aprs.glidernet.org:14580)
 *
 * OGN-flavoured APRS aircraft beacon (see
 * https://ognproject.wikidot.com/wiki:ogn-flavoured-aprs):
 *
 *   FLRDDA5BA>APRS,qAS,LFMX:/074556h4415.41N/00600.75E'268/054/A=005524 id0ADDA5BA -019fpm +0.0rot 55.2dB 0e -4.9kHz
 *
 *   /074556h              timestamp (ignored — packet arrival time used instead)
 *   4415.41N / 00600.75E  position (degrees + decimal minutes)
 *   268/054               course (deg) / ground speed (KNOTS)
 *   A=005524              altitude, FEET
 *   id0ADDA5BA            1-byte metadata prefix (STttttaa bit layout) + 6-hex address
 *   -019fpm               climb rate, feet/minute
 *
 * id-byte bit layout (MSB→LSB): S=stealth, T=no-track, tttt=aircraft type
 * (FLARM's own 4-bit enum, NOT the ADS-B category enum), aa=address type
 * (0=unknown 1=ICAO 2=FLARM 3=OGN-tracker).
 */

import net from 'node:net'
import { BBOX, hasActiveConsumers, updateOgnState, pruneAndBroadcastOgn, type TrafficState } from './traffic'
import { startDdbPrivacyRefresh, isTrackingOptedOut } from './ognDdbPrivacy'

// ── Config ────────────────────────────────────────────────────────────────────

const ENABLED = process.env['OGN_ENABLED'] !== 'false'

const APRS_HOST = process.env['OGN_APRS_HOST'] ?? 'aprs.glidernet.org'
const APRS_PORT = parseInt(process.env['OGN_APRS_PORT'] ?? '14580', 10)

/**
 * APRS-IS server-side filter for the login line. Exported for tests.
 *
 * Default: an area filter covering the same rectangle as OPENSKY_BBOX, so
 * both feeds see the same region. This used to be a 350 km circle around
 * the bbox centre, which for the default Sweden box (55-69.5 N) only
 * reached ~59-65 N: OGN traffic (FLARM gliders and tow planes, and ADS-B
 * that OGN ground receivers hear at low level near airfields) in the whole
 * south of the country was never received.
 *
 * A circle is used only when both OGN_FILTER_LAT and OGN_FILTER_LON are set.
 * (Empty strings count as unset: docker-compose passes `${VAR:-}` as ''.)
 */
export function ognFilter(
  bbox: [number, number, number, number],
  env: Record<string, string | undefined>,
): string {
  const lat = parseFloat(env['OGN_FILTER_LAT'] || '')
  const lon = parseFloat(env['OGN_FILTER_LON'] || '')
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const radius = parseInt(env['OGN_FILTER_RADIUS_KM'] || '350', 10)
    return `r/${lat}/${lon}/${Number.isFinite(radius) && radius > 0 ? radius : 350}`
  }
  const [latMin, lonMin, latMax, lonMax] = bbox
  return `a/${latMax}/${lonMin}/${latMin}/${lonMax}`
}

const FILTER = ognFilter(BBOX, process.env)

/** How stale (seconds) an OGN target can be before it's pruned from the merged batch. Shorter than OpenSky's 180s STALE_S since OGN targets update far more frequently (every few seconds vs. OpenSky's ~65s poll). */
const OGN_STALE_S = 120

/** How often to prune + push a merged rebroadcast, independent of OpenSky's poll cadence. */
const OGN_BROADCAST_INTERVAL_MS = 5_000

/** How often the idle watcher checks whether to connect/disconnect the APRS-IS socket. */
const OGN_IDLE_CHECK_MS = 20_000

/** Backoff after a socket error/close before reconnecting, while consumers remain active. */
const RECONNECT_DELAY_MS = 15_000

// ── FLARM aircraft-type → ADS-B category mapping ─────────────────────────────
//
// Reuses the SAME category enum OpenSky states already carry (see
// TrafficState.category in traffic.ts) so client icon-selection code
// (trafficIcons.ts) needs zero source-aware branching — a glider renders as
// category 8 whether OpenSky or OGN reported it.
//
// FLARM's own enum (hex 0-F, see module doc above) vs. ADS-B's (0-19):
const FLARM_TYPE_TO_CATEGORY: Record<number, number> = {
  0x0: 0,   // reserved/unknown
  0x1: 8,   // glider/motor-glider/TMG           → glider
  0x2: 1,   // tow plane                         → light fixed-wing
  0x3: 7,   // helicopter/gyrocopter/rotorcraft  → rotorcraft
  0x4: 10,  // skydiver/parachute                → parachutist
  0x5: 1,   // drop plane                        → light fixed-wing
  0x6: 11,  // hang glider                       → ultralight
  0x7: 11,  // paraglider                        → ultralight
  0x8: 1,   // powered aircraft (reciprocating)  → light fixed-wing
  0x9: 2,   // jet/turboprop                     → small fixed-wing
  0xA: 0,   // unknown
  0xB: 9,   // balloon                           → LTA
  0xC: 9,   // airship/blimp                     → LTA
  0xD: 13,  // UAV/drone                         → UAV
  0xE: 0,   // reserved
  0xF: -1,  // static obstacle — not traffic, filtered out (see parseLine())
}

// ── APRS-IS aircraft-beacon line parser ──────────────────────────────────────

// Header: SRCCALL>DST,path...:BODY  — split on the first ':' after '>'.
const HEADER_RE = /^([^>]+)>[^:]*:(.*)$/
// Body: /HHMMSSh DDMM.mmN <symtable> DDDMM.mmE <symcode> [course/speed] /A=altft <comment>
const BODY_RE = /^[/=]\d{6}h(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)(?:(\d{3})\/(\d{3}))?\/A=(-?\d{5,6})(.*)$/
const ID_RE = /\bid([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})\b/
const FPM_RE = /([+-]\d+)fpm/
// Position precision enhancement: !Wab! adds a third decimal to the lat (a)
// and lon (b) minutes.
const DAO_RE = /!W(\d)(\d)!/
const FL_RE = /\bFL(-?\d+(?:\.\d+)?)\b/
// ADS-B relayed by OGN receivers: `A3:SAS093` = emitter category (set A,
// same numbers as OpenSky's category 1-7) and flight callsign.
const ADSB_RE = /\bA(\d):(\S+)/

/** Parses one APRS-IS line into a traffic state (null = not an aircraft beacon). Exported for tests. */
export function parseLine(line: string, nowS: number): TrafficState | null {
  if (!line || line.startsWith('#')) return null

  const hm = HEADER_RE.exec(line)
  if (!hm) return null
  const [, srcCall, body] = hm
  if (!srcCall || body === undefined) return null

  const bm = BODY_RE.exec(body)
  if (!bm) return null  // receiver status/metric beacons don't match — filtered out naturally

  const [
    , latDegS, latMinS, ns, , lonDegS, lonMinS, ew, , courseS, speedKnS, altFtS, comment,
  ] = bm
  if (!latDegS || !latMinS || !ns || !lonDegS || !lonMinS || !ew || !altFtS || comment === undefined) return null

  const idm = ID_RE.exec(comment)
  if (!idm) return null  // no OGN id field — can't classify/dedup this beacon, skip
  const [, idByteHex, addrHex] = idm
  if (!idByteHex || !addrHex) return null
  const idByte = parseInt(idByteHex, 16)
  const noTrack = (idByte >> 6) & 1
  if (noTrack) return null  // spec: must be ignored if set (shouldn't appear on public feed anyway)

  const flarmType = (idByte >> 2) & 0xF
  const addressType = idByte & 0x3
  const category = FLARM_TYPE_TO_CATEGORY[flarmType] ?? 0
  if (category < 0) return null  // static obstacle — not a traffic target

  const dao = DAO_RE.exec(comment)
  const latMin = parseFloat(latMinS) + (dao ? parseInt(dao[1]!, 10) / 1000 : 0)
  const lonMin = parseFloat(lonMinS) + (dao ? parseInt(dao[2]!, 10) / 1000 : 0)
  const latDeg = parseFloat(latDegS) + latMin / 60
  const lonDeg = parseFloat(lonDegS) + lonMin / 60
  const lat = ns === 'S' ? -latDeg : latDeg
  const lon = ew === 'W' ? -lonDeg : lonDeg

  const altFt = parseInt(altFtS, 10)
  // A= is the GNSS altitude. ADS-B relays also carry the pressure altitude
  // as FLnnn.nn; FLARM has none, so A= stands in for both.
  const geoAltM = altFt * 0.3048
  const flMatch = FL_RE.exec(comment)
  const altM = flMatch ? parseFloat(flMatch[1]!) * 100 * 0.3048 : geoAltM
  const speedKn = speedKnS != null ? parseInt(speedKnS, 10) : null
  const velocityMs = speedKn != null ? speedKn * 0.5144 : null
  // APRS course: 001-360, 000 = unknown. Without a track, clients must not
  // dead-reckon (they used to move every OGN target due north).
  const course = courseS != null ? parseInt(courseS, 10) : 0
  const trackDeg = course > 0 ? course % 360 : null

  const fpmMatch = FPM_RE.exec(comment)
  const vertRateMs = fpmMatch?.[1] != null ? parseInt(fpmMatch[1], 10) * 0.3048 / 60 : null

  // addressType 1 = ICAO — this OGN target's address IS a real ICAO24, so it
  // can dedup directly against an OpenSky state with the same icao24 (see
  // traffic.ts's mergeTrafficStates()). Anything else (FLARM/OGN-tracker/
  // unknown addressing) gets a namespaced id so it can never collide with an
  // unrelated aircraft's real ICAO24 that happens to share the same hex.
  const icao24 = addressType === 1 ? addrHex.toLowerCase() : `ogn-${addrHex.toLowerCase()}`

  // ICAO-addressed (mostly ADS-B heard by an OGN receiver): the source call
  // is just "ICA" + address, so use the flight callsign from the A<n>: field,
  // or none (the OpenSky state of the same aircraft may have one). Others
  // (FLARM / OGN trackers) keep the source call as their only label.
  const adsb = ADSB_RE.exec(comment)
  const callsign = addressType === 1 ? (adsb?.[2] ?? null) : (srcCall.trim() || null)
  const adsbCategory = adsb ? parseInt(adsb[1]!, 10) : 0

  return {
    icao24,
    callsign,
    lat,
    lon,
    altM,
    geoAltM,
    velocityMs,
    trackDeg,
    vertRateMs,
    // OGN doesn't report an explicit on-ground flag like OpenSky's state
    // vector does — always false. Minor cosmetic gap vs. OpenSky targets:
    // a landed glider still parked with its tracker on will show airborne
    // styling until it stops transmitting and goes stale.
    onGround: false,
    lastContact: nowS,
    posTime: nowS,
    category: adsbCategory > 0 ? adsbCategory : category,
    source: 'ogn',
  }
}

// ── Socket lifecycle ──────────────────────────────────────────────────────────

let _socket: net.Socket | null = null
let _lineBuf = ''
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _idleCheckTimer: ReturnType<typeof setInterval> | null = null
let _broadcastTimer: ReturnType<typeof setInterval> | null = null

function connect(): void {
  if (_socket || !ENABLED) return

  console.log(`[ogn] Connecting to ${APRS_HOST}:${APRS_PORT} (filter ${FILTER})`)
  const socket = net.createConnection({ host: APRS_HOST, port: APRS_PORT })
  _socket = socket
  _lineBuf = ''

  socket.on('connect', () => {
    // Unauthenticated (pass -1) read-only login — OGN's APRS-IS is free/open,
    // no account needed. Callsign just needs to be a plausible-looking APRS
    // ident; doesn't need to be registered.
    const login = `user OPENVFR pass -1 vers openvfr 1.0 filter ${FILTER}\r\n`
    socket.write(login)
    console.log('[ogn] Connected, login sent')
  })

  socket.on('data', (chunk: Buffer) => {
    _lineBuf += chunk.toString('utf8')
    const lines = _lineBuf.split('\n')
    _lineBuf = lines.pop() ?? ''  // keep any partial trailing line for next chunk
    const nowS = Math.floor(Date.now() / 1000)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      const state = parseLine(line, nowS)
      if (!state) continue
      // DDB tracked=N opt-out (ognDdbPrivacy.ts) -- separate mechanism from
      // the no-tracking APRS bit already filtered out in parseLine() above.
      // Required by OGN's data usage rules as a condition of the ODbL
      // license (see ognDdbPrivacy.ts's module doc).
      const bareAddr = state.icao24.startsWith('ogn-') ? state.icao24.slice(4) : state.icao24
      if (isTrackingOptedOut(bareAddr)) continue
      updateOgnState(state)
    }
  })

  socket.on('error', (err) => {
    console.error('[ogn] Socket error:', err.message)
  })

  socket.on('close', () => {
    console.log('[ogn] Socket closed')
    _socket = null
    if (hasActiveConsumers()) {
      _reconnectTimer = setTimeout(() => { _reconnectTimer = null; connect() }, RECONNECT_DELAY_MS)
    }
  })
}

function disconnect(): void {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_socket) {
    console.log('[ogn] No active consumers — disconnecting APRS-IS socket')
    _socket.destroy()
    _socket = null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called once at server boot. Starts the idle-watcher and broadcast tickers
 * immediately (cheap — they just check a boolean / a small in-memory map),
 * but the actual APRS-IS socket only opens once a real consumer shows up,
 * mirroring OpenSky's ensurePolling() idle gating in traffic.ts.
 */
export function startOgnRelay(): void {
  if (!ENABLED) {
    console.log('[ogn] OGN_ENABLED=false — OGN traffic relay disabled')
    return
  }
  startDdbPrivacyRefresh()
  console.log(`[ogn] Relay ready — will connect on first consumer activity (idle-gated), filter ${FILTER}`)

  _idleCheckTimer = setInterval(() => {
    if (hasActiveConsumers()) connect()
    else disconnect()
  }, OGN_IDLE_CHECK_MS)

  _broadcastTimer = setInterval(() => {
    if (_socket) pruneAndBroadcastOgn(OGN_STALE_S)
  }, OGN_BROADCAST_INTERVAL_MS)
}
