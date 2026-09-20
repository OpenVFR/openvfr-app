/**
 * useSimInput — connects to a flight simulator and streams GpsPosition.
 *
 * ── Native advantage over web ────────────────────────────────────────────────
 * The web app requires an external Node bridge (scripts/nmea-ws-bridge.mjs)
 * because browsers cannot open UDP sockets. On native we can listen directly
 * on UDP 49002, eliminating the bridge entirely for the common case.
 *
 * ── Supported input sources ──────────────────────────────────────────────────
 *
 * Mode A — UDP broadcast (PRIMARY, no setup on PC required):
 *   X-Plane 11/12:   Settings → Network → "Broadcast to all mapping apps"
 *                    Broadcasts XGPS packets on UDP 49002 to the whole LAN.
 *   MSFS 2024:       Install a free XGPS-broadcast bridge add-on.
 *                    Broadcasts XGPS on UDP 49002 automatically.
 *   Packet format:   XGPSXPlane,<lon>,<lat>,<alt_m_msl>,<track_true_deg>,<speed_mps>
 *   Just start the sim and tap "Connect via UDP" — no IP, no config.
 *
 * Mode B — WebSocket bridge (FALLBACK, for TCP NMEA sources):
 *   Run scripts/nmea-ws-bridge.mjs on the simulator PC.
 *   Enter the PC's LAN IP in the app: ws://192.168.1.xxx:5104
 *   Accepts both XGPS and NMEA ($GPRMC/$GPGGA) sentences.
 *   Use this when UDP broadcast is blocked by the router or when the
 *   only available source outputs TCP NMEA and needs the bridge as a relay.
 *
 * ── Future improvements ────────────────────────────────────────────────────
 * 1. SSE/WebSocket: see traffic polling note in useTraffic.ts.
 *
 * 2. GDL90 protocol (UDP 4000) — SkyEcho 2, iLevil, Sentry:
 *    These devices are common in European GA and broadcast real aircraft
 *    traffic + GPS position in GDL90 format on UDP 4000 via their own Wi-Fi.
 *    A Mode C could decode GDL90 messages (MSG ID 11 = ownship, ID 20 = traffic)
 *    to provide both GPS position and traffic without the OpenSky server.
 *
 * 3. FLARM (PowerFLARM, Air Connect dongle):
 *    Widely used in EU gliding and GA. FLARM broadcasts on its own network
 *    and sends NMEA + PFLAA/PFLAU sentences. A Bluetooth FLARM receiver would
 *    be mode D — React Native supports Bluetooth serial via react-native-bluetooth-serial.
 *
 * 4. Direct TCP NMEA (no bridge):
 *    react-native-tcp-socket can connect directly to X-Plane 12's built-in
 *    GPS TCP output or any other app exposing a TCP NMEA port, without any
 *    bridge script. Zero-setup alternative to Mode B for users who prefer
 *    TCP over WebSocket.
 *
 * 5. Dynon SkyView / Avidyne IFD:
 *    Both expose a Wi-Fi network and accept TCP connections for GPS + route sync.
 *    Would be Mode E/F in a future Connectivity settings screen.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import UdpSockets from 'react-native-udp'
import type { GpsPosition } from '../utils/gpsTypes'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SimMode = 'off' | 'udp' | 'ws'

export type SimStatus =
  | { mode: 'off'  }
  | { mode: 'udp';  port: number; receiving: boolean }
  | { mode: 'ws';   url: string  }
  | { mode: 'error'; message: string }

export type UseSimInputResult = {
  simStatus:   SimStatus
  simPosition: GpsPosition | null
  /** Listen on UDP 49002 for X-Plane / MSFS XGPS broadcast. */
  startUdp:    () => void
  /** Connect to nmea-ws-bridge WebSocket. */
  startWs:     (url: string) => void
  stopSim:     () => void
}

const UDP_PORT = 49002

// ── NMEA helpers (shared with web useGoFlying) ────────────────────────────────

function parseDMM(raw: string, dir: string): number {
  if (!raw) return 0
  const dot = raw.indexOf('.')
  if (dot < 0) return 0
  const degLen = dot - 2
  const deg = parseFloat(raw.slice(0, degLen))
  const min = parseFloat(raw.slice(degLen))
  const val = deg + min / 60
  return (dir === 'S' || dir === 'W') ? -val : val
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSimInput(): UseSimInputResult {
  const [simStatus,   setSimStatus]   = useState<SimStatus>({ mode: 'off' })
  const [simPosition, setSimPosition] = useState<GpsPosition | null>(null)

  const udpRef = useRef<ReturnType<typeof UdpSockets.createSocket> | null>(null)
  const wsRef  = useRef<WebSocket | null>(null)
  const modeRef = useRef<SimMode>('off')

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const stopSim = useCallback(() => {
    modeRef.current = 'off'

    if (udpRef.current) {
      try { udpRef.current.close() } catch { /* ignore */ }
      udpRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }

    setSimStatus({ mode: 'off' })
    setSimPosition(null)
  }, [])

  useEffect(() => () => { stopSim() }, [stopSim])

  // ── XGPS packet parser (X-Plane + MSFS via a broadcast bridge add-on) ───────
  const parseXgps = useCallback((line: string): GpsPosition | null => {
    // XGPSXPlane,lon,lat,alt_m_msl,track_true_deg,speed_mps
    if (!line.startsWith('XGPS')) return null
    const f = line.replace(/\0+$/, '').split(',')
    if (f.length < 6) return null
    const lon      = parseFloat(f[1])
    const lat      = parseFloat(f[2])
    const altM     = parseFloat(f[3])
    const trackDeg = parseFloat(f[4])
    const speedMps = parseFloat(f[5])
    if (!isFinite(lat) || !isFinite(lon)) return null
    return {
      lat,
      lng:      lon,
      altFt:    altM * 3.28084,
      speedKts: speedMps * 1.94384,
      trackDeg: trackDeg || 0,
      accuracy: 5,
    }
  }, [])

  // ── NMEA sentence parser ($GPRMC / $GPGGA) ─────────────────────────────────
  const nmeaPartialRef = useRef({ lat: 0, lng: 0, altFt: 0, speedKts: 0, trackDeg: 0, hasPos: false })

  const parseNmea = useCallback((line: string): GpsPosition | null => {
    const raw  = line.includes('*') ? line.slice(0, line.lastIndexOf('*')) : line
    const f    = raw.split(',')
    const type = f[0]
    const p    = nmeaPartialRef.current

    if (type === '$GPRMC' || type === '$GNRMC') {
      if (f[2] !== 'A') return null
      p.lat      = parseDMM(f[3], f[4])
      p.lng      = parseDMM(f[5], f[6])
      p.speedKts = parseFloat(f[7]) || 0
      p.trackDeg = parseFloat(f[8]) || 0
      p.hasPos   = true
    } else if (type === '$GPGGA' || type === '$GNGGA') {
      if (f[6] === '0') return null
      p.altFt = (parseFloat(f[9]) || 0) * 3.28084
      if (!p.hasPos && f[2]) {
        p.lat    = parseDMM(f[2], f[3])
        p.lng    = parseDMM(f[4], f[5])
        p.hasPos = true
      }
    }

    if (!p.hasPos) return null
    return { lat: p.lat, lng: p.lng, altFt: p.altFt, speedKts: p.speedKts, trackDeg: p.trackDeg, accuracy: 5 }
  }, [])

  // ── Mode A: UDP broadcast ─────────────────────────────────────────────────
  const startUdp = useCallback(() => {
    stopSim()
    modeRef.current = 'udp'

    const socket = UdpSockets.createSocket({ type: 'udp4', reusePort: true })
    udpRef.current = socket

    // Flag: suppress async errors from addMembership (multicast join may fail
    // on some Android devices but broadcast reception still works once the
    // WifiManager.MulticastLock is acquired before the join attempt).
    let suppressNextError = false

    let pktCount = 0
    socket.on('message', (msg: Buffer, rinfo?: { address?: string; port?: number }) => {
      const text = msg.toString('utf8')
      pktCount++
      const verbose = pktCount === 1 || pktCount % 50 === 0
      if (verbose) console.log(`[sim/udp] #${pktCount} from ${rinfo?.address}:${rinfo?.port}, ${msg.length}B:`, text.slice(0, 120))

      if (modeRef.current === 'udp') {
        setSimStatus(prev => (prev.mode === 'udp' && !prev.receiving)
          ? { mode: 'udp', port: UDP_PORT, receiving: true }
          : prev)
      }

      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const pos = parseXgps(trimmed) ?? parseNmea(trimmed)
        if (pos) {
          setSimPosition(pos)
          if (verbose) console.log('[sim/udp] parsed pos:', pos.lat, pos.lng)
        } else if (verbose) {
          console.log('[sim/udp] unparsed:', trimmed.slice(0, 60))
        }
      }
    })

    socket.on('error', (err: Error) => {
      if (suppressNextError) {
        suppressNextError = false
        console.warn('[sim/udp] multicast join error (ignored, broadcast still works):', err.message)
        return
      }
      console.warn('[sim/udp] error:', err.message)
      stopSim()
      setSimStatus({ mode: 'error', message: `UDP error: ${err.message}` })
    })

    socket.bind(UDP_PORT, '0.0.0.0', () => {
      try { socket.setBroadcast(true) } catch { /* ignore */ }
      // addMembership acquires Android WifiManager.MulticastLock — required for
      // the Wi-Fi driver to pass broadcast packets to the app (not just multicast).
      // 224.0.0.1 = All Systems group; the join itself may fail but the lock
      // acquisition is the side-effect we need.
      suppressNextError = true
      try { socket.addMembership('224.0.0.1') } catch { suppressNextError = false }
      console.log('[sim/udp] bound on 0.0.0.0:' + UDP_PORT)
      setSimStatus({ mode: 'udp', port: UDP_PORT, receiving: false })
    })
  }, [stopSim, parseXgps, parseNmea])

  // ── Mode B: WebSocket bridge ──────────────────────────────────────────────
  const startWs = useCallback((url: string) => {
    stopSim()
    modeRef.current = 'ws'
    nmeaPartialRef.current = { lat: 0, lng: 0, altFt: 0, speedKts: 0, trackDeg: 0, hasPos: false }

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      setSimStatus({ mode: 'error', message: `Invalid URL: ${url}` })
      return
    }
    wsRef.current = ws

    ws.onopen  = () => setSimStatus({ mode: 'ws', url })

    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : ''
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const pos = parseXgps(trimmed) ?? parseNmea(trimmed)
        if (pos) setSimPosition(pos)
      }
    }

    ws.onerror = () => {
      if (modeRef.current !== 'ws') return
      stopSim()
      setSimStatus({ mode: 'error', message: `Could not connect to ${url}` })
    }

    ws.onclose = () => {
      if (modeRef.current !== 'ws') return
      stopSim()
      setSimStatus({ mode: 'error', message: `Disconnected from ${url}` })
    }
  }, [stopSim, parseXgps, parseNmea])

  return { simStatus, simPosition, startUdp, startWs, stopSim }
}
