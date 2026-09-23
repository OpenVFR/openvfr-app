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
 *    (`filter r/lat/lon/radius_km`) so aprs.glidernet.org only sends
 *    packets for the configured region — no full-network firehose, no
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
 *   OGN_FILTER_LAT/LON     APRS-IS filter centre (default: OPENSKY_BBOX midpoint)
 *   OGN_FILTER_RADIUS_KM   APRS-IS filter radius, km (default: 350)
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

function bboxCenter(bbox: [number, number, number, number]): [number, number] {
  const [latMin, lonMin, latMax, lonMax] = bbox
  return [(latMin + latMax) / 2, (lonMin + lonMax) / 2]
}

const [DEFAULT_LAT, DEFAULT_LON] = bboxCenter(BBOX)

// (process.env[...] || '') rather than ?? -- docker-compose passes empty-string
// defaults for unset vars (${VAR:-}), which ?? would NOT treat as "unset".
const FILTER_LAT = parseFloat(process.env['OGN_FILTER_LAT'] || String(DEFAULT_LAT))
const FILTER_LON = parseFloat(process.env['OGN_FILTER_LON'] || String(DEFAULT_LON))
const FILTER_RADIUS_KM = parseInt(process.env['OGN_FILTER_RADIUS_KM'] || '350', 10)

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
const BODY_RE = /^[/=]\d{6}h(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)(?:(\d{3})\/(\d{3}))?\/A=(\d{6})(.*)$/
const ID_RE = /\bid([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})\b/
const FPM_RE = /([+-]\d+)fpm/

function parseLine(line: string, nowS: number): TrafficState | null {
  if (!line || line.startsWith('#')) return null

  const hm = HEADER_RE.exec(line)
  if (!hm) return null
  const [, srcCall, body] = hm
  if (!srcCall || body === undefined) return null

  const bm = BODY_RE.exec(body)
  if (!bm) return null  // receiver status/metric beacons don't match — filtered out naturally

  const [
    , latDegS, latMinS, ns, , lonDegS, lonMinS, ew, , , speedKnS, altFtS, comment,
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

  const latDeg = parseFloat(latDegS) + parseFloat(latMinS) / 60
  const lonDeg = parseFloat(lonDegS) + parseFloat(lonMinS) / 60
  const lat = ns === 'S' ? -latDeg : latDeg
  const lon = ew === 'W' ? -lonDeg : lonDeg

  const altFt = parseInt(altFtS, 10)
  const altM = altFt * 0.3048
  const speedKn = speedKnS != null ? parseInt(speedKnS, 10) : null
  const velocityMs = speedKn != null ? speedKn * 0.5144 : null

  const fpmMatch = FPM_RE.exec(comment)
  const vertRateMs = fpmMatch?.[1] != null ? parseInt(fpmMatch[1], 10) * 0.3048 / 60 : null

  // addressType 1 = ICAO — this OGN target's address IS a real ICAO24, so it
  // can dedup directly against an OpenSky state with the same icao24 (see
  // traffic.ts's recomputeAndBroadcast()). Anything else (FLARM/OGN-tracker/
  // unknown addressing) gets a namespaced id so it can never collide with an
  // unrelated aircraft's real ICAO24 that happens to share the same hex.
  const icao24 = addressType === 1 ? addrHex.toLowerCase() : `ogn-${addrHex.toLowerCase()}`

  return {
    icao24,
    callsign: srcCall.trim() || null,
    lat,
    lon,
    altM,
    velocityMs,
    trackDeg: null,  // course field exists but omitted from BODY_RE destructure above (not currently surfaced); could add if needed
    vertRateMs,
    // OGN doesn't report an explicit on-ground flag like OpenSky's state
    // vector does — always false. Minor cosmetic gap vs. OpenSky targets:
    // a landed glider still parked with its tracker on will show airborne
    // styling until it stops transmitting and goes stale.
    onGround: false,
    lastContact: nowS,
    category,
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

  console.log(`[ogn] Connecting to ${APRS_HOST}:${APRS_PORT} (filter r/${FILTER_LAT}/${FILTER_LON}/${FILTER_RADIUS_KM})`)
  const socket = net.createConnection({ host: APRS_HOST, port: APRS_PORT })
  _socket = socket
  _lineBuf = ''

  socket.on('connect', () => {
    // Unauthenticated (pass -1) read-only login — OGN's APRS-IS is free/open,
    // no account needed. Callsign just needs to be a plausible-looking APRS
    // ident; doesn't need to be registered.
    const login = `user OPENVFR pass -1 vers openvfr 1.0 filter r/${FILTER_LAT}/${FILTER_LON}/${FILTER_RADIUS_KM}\r\n`
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
  console.log(`[ogn] Relay ready — will connect on first consumer activity (idle-gated), region centre (${FILTER_LAT}, ${FILTER_LON}) r=${FILTER_RADIUS_KM}km`)

  _idleCheckTimer = setInterval(() => {
    if (hasActiveConsumers()) connect()
    else disconnect()
  }, OGN_IDLE_CHECK_MS)

  _broadcastTimer = setInterval(() => {
    if (_socket) pruneAndBroadcastOgn(OGN_STALE_S)
  }, OGN_BROADCAST_INTERVAL_MS)
}
