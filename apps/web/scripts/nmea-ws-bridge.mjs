#!/usr/bin/env node
/**
 * nmea-ws-bridge.mjs
 *
 * Bridges NMEA sentences from a flight simulator to the open-vfr browser app
 * via WebSocket. No npm dependencies — pure Node.js built-ins only.
 *
 * ┌──────────────────────┐  TCP:5100  ┌──────────────────┐  WS:5101  ┌──────────┐
 * │ X-Plane (XPlane2NMEA │ ─────────▶ │                  │ ─────────▶│ Browser  │
 * │ or built-in NMEA)    │            │  nmea-ws-bridge  │           │ open-vfr │
 * │ MSFS 2024            │ ─────────▶ │                  │           │          │
 * │ (Little Navmap TCP)  │            └──────────────────┘           └──────────┘
 * └──────────────────────┘
 *
 * Usage:
 *   node scripts/nmea-ws-bridge.mjs [tcp-port] [ws-port]
 *   node scripts/nmea-ws-bridge.mjs 5100 5101   (defaults)
 *
 * ─── X-Plane setup ────────────────────────────────────────────────────────────
 * Option A — UDP broadcast (simplest, no plugin needed):
 *   Settings → Network → iPhone, iPad and External Apps
 *   ✓ "Broadcast to all mapping apps on the network"
 *   The bridge listens automatically on UDP port 49002.
 *
 * Option B — XPlane2NMEA plugin (more data, free, x-plane.org/plugin-browser):
 *   Configure: Protocol = TCP, Host = 127.0.0.1, Port = 5100
 *
 * Option C — X-Plane 12 built-in NMEA:
 *   Settings → Network → GPS Output → enable, TCP, port 5100
 *
 * ─── MSFS 2024 setup ──────────────────────────────────────────────────────────
 * Option A — FS2FF (recommended, free, fs2ff.com):
 *   Broadcasts XGPS packets on UDP 49002 — same protocol as X-Plane.
 *   The bridge picks it up automatically via the UDP listener. No config needed.
 *
 * Option B — FSConny (free, fsconny.com):
 *   Also broadcasts XGPS on UDP 49002. Same as FS2FF — works automatically.
 *
 * Option C — Little Navmap TCP NMEA (advanced):
 *   Tools → Options → Simulator Aircraft → "Send NMEA to TCP client on port" = 5103
 *
 * ─── Browser setup ────────────────────────────────────────────────────────────
 * In open-vfr: Go Flying → External Sim → set URL to ws://localhost:5101 → Connect
 */

import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createSocket as createUdpSocket } from 'node:dgram'
import { createHash } from 'node:crypto'

const TCP_PORT = Number(process.argv[2] ?? 5103)
const WS_PORT  = Number(process.argv[3] ?? 5104)
const UDP_PORT = 49002   // X-Plane ForeFlight / mapping-apps broadcast port (fixed)
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ── Active WebSocket client sockets ─────────────────────────────────────────
const clients = new Set()

/** Encode and send a WebSocket text frame (server→client, unmasked per RFC 6455 §5.1) */
function wsSend(socket, text) {
  const data = Buffer.from(text, 'utf8')
  const len  = data.length
  let header
  if (len <= 125) {
    header = Buffer.from([0x81, len])
  } else if (len <= 65535) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    return // NMEA sentences are max 82 chars — this never fires
  }
  try {
    socket.write(Buffer.concat([header, data]))
  } catch {
    clients.delete(socket)
  }
}

/** Forward an NMEA sentence to all connected browsers */
function broadcast(sentence) {
  const line = sentence.trim()
  if (!line) return
  for (const s of clients) wsSend(s, line)
}

// ── NMEA helpers for XGPS→NMEA conversion ──────────────────────────────────

/** XOR checksum over NMEA body (everything between $ and * exclusive). */
function nmeaChecksum(body) {
  let cs = 0
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i)
  return cs.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * Decimal degrees → NMEA DDmm.mmmm (lat) or DDDmm.mmmm (lon) string.
 * @param {number}  decDeg  Absolute decimal degrees
 * @param {boolean} isLon   True → 3-digit degree prefix
 */
function toNmeaDeg(decDeg, isLon) {
  const abs    = Math.abs(decDeg)
  const deg    = Math.floor(abs)
  const min    = (abs - deg) * 60
  const degStr = isLon ? String(deg).padStart(3, '0') : String(deg).padStart(2, '0')
  return `${degStr}${min.toFixed(4).padStart(7, '0')}`
}

/**
 * Convert an X-Plane XGPS UDP broadcast packet to [$GPRMC, $GPGGA] sentences.
 *
 * Packet format (null-terminated):
 *   XGPSXPlane,<lon>,<lat>,<alt_m_msl>,<track_true_deg>,<speed_mps>
 *
 * Returns an array of two NMEA sentence strings, or null if malformed.
 */
function xgpsToNmea(packet) {
  const parts = packet.replace(/\0+$/, '').split(',')
  if (parts.length < 6 || !parts[0].startsWith('XGPS')) return null

  const lon      = parseFloat(parts[1])
  const lat      = parseFloat(parts[2])
  const altM     = parseFloat(parts[3])
  const trackDeg = parseFloat(parts[4])
  const speedMps = parseFloat(parts[5])

  if (!isFinite(lat) || !isFinite(lon)) return null

  const speedKts = speedMps * 1.94384

  const now  = new Date()
  const time = `${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}${String(now.getUTCSeconds()).padStart(2,'0')}.00`
  const date = `${String(now.getUTCDate()).padStart(2,'0')}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCFullYear()).slice(-2)}`

  const latStr = toNmeaDeg(lat, false)
  const latDir = lat >= 0 ? 'N' : 'S'
  const lonStr = toNmeaDeg(lon, true)
  const lonDir = lon >= 0 ? 'E' : 'W'

  const rmcBody = `GPRMC,${time},A,${latStr},${latDir},${lonStr},${lonDir},${speedKts.toFixed(1)},${trackDeg.toFixed(1)},${date},,,A`
  const rmc     = `$${rmcBody}*${nmeaChecksum(rmcBody)}`

  const ggaBody = `GPGGA,${time},${latStr},${latDir},${lonStr},${lonDir},1,08,1.0,${altM.toFixed(1)},M,0.0,M,,`
  const gga     = `$${ggaBody}*${nmeaChecksum(ggaBody)}`

  return [rmc, gga]
}

// ── TCP server — receives NMEA sentences from the simulator ─────────────────
const tcpServer = createTcpServer(socket => {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`
  console.log(`[TCP] Simulator connected   ${addr}`)

  let buf = ''
  socket.setEncoding('utf8')

  socket.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const s = line.trim()
      // Accept $GP* (single-constellation GPS) and $GN* (multi-constellation GNSS)
      if (s.startsWith('$GP') || s.startsWith('$GN')) {
        broadcast(s)
      }
    }
  })

  socket.on('close', () => console.log(`[TCP] Simulator disconnected ${addr}`))
  socket.on('error', () => {})
})

// ── UDP server — receives X-Plane XGPS broadcast (port 49002) ──────────────
const udpSocket = createUdpSocket('udp4')
let udpPeerLogged = false

udpSocket.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8')
  if (!text.startsWith('XGPS')) return  // ignore XATT and unknown packets

  if (!udpPeerLogged) {
    console.log(`[UDP] X-Plane connected     ${rinfo.address}:${rinfo.port}`)
    udpPeerLogged = true
  }

  const sentences = xgpsToNmea(text)
  if (sentences) {
    for (const s of sentences) broadcast(s)
  }
})

udpSocket.on('error', err => console.error(`[UDP] Error: ${err.message}`))
udpSocket.bind(UDP_PORT)

// ── HTTP + WebSocket server — browsers connect here ─────────────────────────
const httpServer = createHttpServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(
    `open-vfr NMEA WebSocket bridge running\n` +
    `Connect your simulator NMEA output to TCP port ${TCP_PORT}\n` +
    `Connect open-vfr browser to ws://localhost:${WS_PORT}\n`,
  )
})

httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }

  const accept = createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  clients.add(socket)
  console.log(`[WS]  Browser connected    (${clients.size} active)`)

  socket.on('close', () => {
    clients.delete(socket)
    console.log(`[WS]  Browser disconnected (${clients.size} active)`)
  })
  socket.on('error', () => clients.delete(socket))
  socket.on('data',  () => {}) // ignore frames from browser
})

// ── Start both servers ───────────────────────────────────────────────────────
tcpServer.listen(TCP_PORT)
httpServer.listen(WS_PORT, () => {
  console.log()
  console.log('┌─────────────────────────────────────────────────────────┐')
  console.log('│             open-vfr NMEA WebSocket Bridge              │')
  console.log('├─────────────────────────────────────────────────────────┤')
  console.log(`│  UDP  X-Plane broadcast  → bridge   *:${String(UDP_PORT).padEnd(17)}│`)
  console.log(`│  TCP  NMEA (plugin/MSFS) → bridge   127.0.0.1:${String(TCP_PORT).padEnd(9)}│`)
  console.log(`│  WS   bridge → browser              ws://localhost:${String(WS_PORT).padEnd(5)}│`)
  console.log('├─────────────────────────────────────────────────────────┤')
  console.log('│  X-Plane UDP:  Settings → Network → External Apps       │')
  console.log('│                ✓ Broadcast to all mapping apps (UDP 49002│')
  console.log('│  X-Plane TCP:  XPlane2NMEA plugin → TCP 127.0.0.1:' + TCP_PORT + '  │')
  console.log('│  MSFS 2024:    Little Navmap TCP NMEA → port ' + TCP_PORT + '       │')
  console.log('│  Browser:      Go Flying → External Sim → ws://localhost:' + WS_PORT + '│')
  console.log('└─────────────────────────────────────────────────────────┘')
  console.log()
  console.log('Listening on UDP port', UDP_PORT, '(X-Plane broadcast) and TCP port', TCP_PORT, '...')
  console.log()
})
