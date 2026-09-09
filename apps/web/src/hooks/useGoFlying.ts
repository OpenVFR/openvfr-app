/**
 * useGoFlying — unified hook for real GPS and keyboard-driven simulation.
 *
 * GPS mode:   wraps navigator.geolocation.watchPosition; requests Wake Lock.
 * Sim mode:   runs a 200 ms setInterval tick loop; keyboard arrow keys steer;
 *             Q key advances 1 NM; drag-to-reposition is handled in MapView
 *             via the exported `teleport()` callback.
 *
 * Both modes return the same GpsPosition shape so consumers are agnostic.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition, FlyingMode } from '../utils/gpsTypes'
import { bearingDeg, distanceNm, advancePosition } from '../utils/routeCalc'
import type { RouteWaypoint } from '../utils/routeCalc'

// ── Simulation helpers ──────────────────────────────────────────────────────

// ── NMEA helpers ────────────────────────────────────────────────────────────

/**
 * Convert NMEA degree-minute format (DDMM.MMMM or DDDMM.MMMM) to decimal degrees.
 * dir is 'N'|'S'|'E'|'W'.
 */
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

// ── Sim state (all mutable, lives in a ref) ─────────────────────────────────

type SimState = {
  lat:       number
  lng:       number
  altFt:     number
  speedKts:  number
  trackDeg:  number
  /** Click-to-navigate target; cleared when aircraft arrives within 0.1 NM. */
  targetLat: number | null
  targetLng: number | null
}

// ── Hook ────────────────────────────────────────────────────────────────────

export type UseGoFlyingReturn = {
  mode:     FlyingMode
  position: GpsPosition | null
  /** Start real GPS (falls back to sim offer on error via onGpsError callback). */
  startGps: (onError?: () => void) => void
  /** Start keyboard simulation. `initialPos` defaults to first route waypoint or Stockholm.
   *  `initialSpeedKts` defaults to 90 if not provided (e.g. no aircraft profile selected). */
  startSim: (initialPos?: { lat: number; lng: number }, initialSpeedKts?: number) => void
  /** Connect to an external simulator (X-Plane / MSFS) via a WebSocket NMEA bridge. */
  startExt: (wsUrl: string, onError?: (msg: string) => void) => void
  stop:     () => void
  /** Sim-only: teleport aircraft to a new position (used for drag-to-reposition). */
  teleport: (lat: number, lng: number) => void
  /** Sim-only: set a click-to-navigate target; aircraft will steer and fly towards it. */
  setSimTarget: (lat: number, lng: number) => void
}

export function useGoFlying(routeWaypoints: RouteWaypoint[]): UseGoFlyingReturn {
  const [mode,     setMode]     = useState<FlyingMode>('off')
  const [position, setPosition] = useState<GpsPosition | null>(null)

  // All sim state lives here — no React renders per-tick, only on position change
  const simRef      = useRef<SimState | null>(null)
  const keysDownRef = useRef(new Set<string>())

  // Cleanup handles
  const watchIdRef  = useRef<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const wsRef       = useRef<WebSocket | null>(null)

  // Stable refs to avoid stale closures in callbacks
  const modeRef       = useRef<FlyingMode>('off')
  const routeWpRef    = useRef<RouteWaypoint[]>(routeWaypoints)

  useEffect(() => { modeRef.current    = mode }, [mode])
  useEffect(() => { routeWpRef.current = routeWaypoints }, [routeWaypoints])

  // ── Cleanup helper (pure side effects, no state updates) ─────────────────
  const doCleanup = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onclose = null  // prevent re-entry
      wsRef.current.close()
      wsRef.current = null
    }
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
    simRef.current = null
    keysDownRef.current.clear()
  }, [])

  // ── Wake Lock ─────────────────────────────────────────────────────────────
  const acquireWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return
    try {
      wakeLockRef.current = await (navigator as Navigator & {
        wakeLock: { request: (type: string) => Promise<WakeLockSentinel> }
      }).wakeLock.request('screen')
    } catch { /* denied or not supported — continue without it */ }
  }, [])

  // ── Stop ──────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    doCleanup()
    setMode('off')
    setPosition(null)
  }, [doCleanup])

  // ── Real GPS ──────────────────────────────────────────────────────────────
  const startGps = useCallback((onError?: () => void) => {
    doCleanup()
    setMode('gps')
    void acquireWakeLock()

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat:      pos.coords.latitude,
          lng:      pos.coords.longitude,
          altFt:    (pos.coords.altitude  ?? 0) * 3.28084,
          speedKts: (pos.coords.speed     ?? 0) * 1.94384,
          trackDeg: (pos.coords.heading   ?? 0) || 0,
          accuracy: pos.coords.accuracy,
        })
      },
      (_err) => {
        doCleanup()
        setMode('off')
        setPosition(null)
        onError?.()
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    )
    watchIdRef.current = watchId
  }, [doCleanup, acquireWakeLock])

  // ── Simulation ────────────────────────────────────────────────────────────
  const startSim = useCallback((initialPos?: { lat: number; lng: number }, initialSpeedKts?: number) => {
    doCleanup()

    const wps        = routeWpRef.current
    const startPos   = initialPos ?? wps[0] ?? { lat: 59.33, lng: 18.07 }
    // Point toward the second waypoint if available, else north
    const startTrack = wps.length >= 2 ? bearingDeg(wps[0], wps[1]) : 0
    const speed      = initialSpeedKts ?? 90

    simRef.current = {
      lat:       startPos.lat,
      lng:       startPos.lng,
      altFt:     1000,
      speedKts:  speed,
      trackDeg:  startTrack,
      targetLat: null,
      targetLng: null,
    }

    setMode('sim')
    void acquireWakeLock()

    // Emit initial position immediately so the aircraft icon appears
    setPosition({
      lat:      startPos.lat,
      lng:      startPos.lng,
      altFt:    1000,
      speedKts: speed,
      trackDeg: startTrack,
      accuracy: 0,
    })

    // 5 Hz tick loop
    const TICK_MS  = 200
    const TICK_S   = TICK_MS / 1000

    const tick = () => {
      const s    = simRef.current
      if (!s) return
      const keys = keysDownRef.current

      const TURN_DEG_S  = 3    // turn rate °/s
      const SPEED_KTS_S = 2    // acceleration kts/s
      const ALT_FT_S    = 200  // climb/descent rate ft/s

      // ── Click-to-navigate: steer toward target (overrides keyboard turn) ─
      if (s.targetLat !== null && s.targetLng !== null) {
        const distToTarget = distanceNm(s, { lat: s.targetLat, lng: s.targetLng })
        if (distToTarget < 0.1) {
          s.targetLat = null
          s.targetLng = null
        } else {
          const targetBrg = bearingDeg(s, { lat: s.targetLat, lng: s.targetLng })
          const diff       = ((targetBrg - s.trackDeg + 540) % 360) - 180  // −180..+180
          const maxTurn    = TURN_DEG_S * TICK_S
          s.trackDeg = (s.trackDeg + Math.max(-maxTurn, Math.min(maxTurn, diff)) + 360) % 360
        }
      }

      // ── Apply held-key effects ──────────────────────────────────────────
      if (keys.has('ArrowLeft'))                s.trackDeg = (s.trackDeg - TURN_DEG_S * TICK_S + 360) % 360
      if (keys.has('ArrowRight'))               s.trackDeg = (s.trackDeg + TURN_DEG_S * TICK_S)       % 360
      if (keys.has('ArrowUp'))                  s.speedKts = Math.min(300, s.speedKts + SPEED_KTS_S * TICK_S)
      if (keys.has('ArrowDown'))                s.speedKts = Math.max(0,   s.speedKts - SPEED_KTS_S * TICK_S)
      if (keys.has('+') || keys.has('='))       s.altFt    = Math.min(50000, s.altFt + ALT_FT_S * TICK_S)
      if (keys.has('-') || keys.has('_'))       s.altFt    = Math.max(0,     s.altFt - ALT_FT_S * TICK_S)

      // ── Advance position ────────────────────────────────────────────────
      const distNm = s.speedKts * TICK_S / 3600
      if (distNm > 0) {
        const { lat, lng } = advancePosition(s.lat, s.lng, s.trackDeg, distNm)
        s.lat = lat
        s.lng = lng
      }

      setPosition({
        lat:      s.lat,
        lng:      s.lng,
        altFt:    s.altFt,
        speedKts: s.speedKts,
        trackDeg: s.trackDeg,
        accuracy: 0,
      })
    }

    intervalRef.current = setInterval(tick, TICK_MS)
  }, [doCleanup, acquireWakeLock])

  // ── External simulator — WebSocket NMEA receiver ────────────────────────
  const startExt = useCallback((
    wsUrl:   string,
    onError?: (msg: string) => void,
  ) => {
    doCleanup()
    setMode('ext')
    void acquireWakeLock()

    // Partial position state — updated from $GPRMC and $GPGGA sentences
    const partial = { lat: 0, lng: 0, altFt: 0, speedKts: 0, trackDeg: 0, hasPos: false }

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      doCleanup()
      setMode('off')
      onError?.(`Invalid WebSocket URL: ${wsUrl}`)
      return
    }
    wsRef.current = ws

    ws.onmessage = (e) => {
      const line = (e.data as string).trim()

      // ── X-Plane XGPS sentence (raw, if bridge passes it through) ─────────
      // Format: XGPSXPlane,lon,lat,alt_m_msl,track_true_deg,speed_mps
      if (line.startsWith('XGPS')) {
        const f = line.replace(/\0+$/, '').split(',')
        if (f.length >= 6) {
          const lon      = parseFloat(f[1])
          const lat      = parseFloat(f[2])
          const altM     = parseFloat(f[3])
          const trackDeg = parseFloat(f[4])
          const speedMps = parseFloat(f[5])
          if (isFinite(lat) && isFinite(lon)) {
            setPosition({
              lat,
              lng:      lon,
              altFt:    altM * 3.28084,
              speedKts: speedMps * 1.94384,
              trackDeg: trackDeg || 0,
              accuracy: 5,
            })
          }
        }
        return
      }

      // ── NMEA sentences ($GPRMC / $GPGGA) ─────────────────────────────────
      // Strip NMEA checksum (*XX suffix)
      const raw  = line.includes('*') ? line.slice(0, line.lastIndexOf('*')) : line
      const f    = raw.split(',')
      const type = f[0]

      if (type === '$GPRMC' || type === '$GNRMC') {
        // Field 2: A=active, V=void
        if (f[2] !== 'A') return
        partial.lat      = parseDMM(f[3], f[4])
        partial.lng      = parseDMM(f[5], f[6])
        partial.speedKts = parseFloat(f[7])  || 0
        partial.trackDeg = parseFloat(f[8])  || 0
        partial.hasPos   = true
      } else if (type === '$GPGGA' || type === '$GNGGA') {
        // Field 6: fix quality — 0 = invalid
        if (f[6] === '0') return
        partial.altFt = (parseFloat(f[9]) || 0) * 3.28084  // metres → ft
        if (!partial.hasPos && f[2]) {
          partial.lat    = parseDMM(f[2], f[3])
          partial.lng    = parseDMM(f[4], f[5])
          partial.hasPos = true
        }
      }

      if (partial.hasPos) {
        setPosition({
          lat:      partial.lat,
          lng:      partial.lng,
          altFt:    partial.altFt,
          speedKts: partial.speedKts,
          trackDeg: partial.trackDeg,
          accuracy: 5,
        })
      }
    }

    ws.onerror = () => {
      doCleanup()
      setMode('off')
      setPosition(null)
      onError?.(`Could not connect to ${wsUrl}`)
    }

    ws.onclose = () => {
      if (modeRef.current === 'ext') {
        doCleanup()
        setMode('off')
        setPosition(null)
        onError?.(`WebSocket disconnected`)
      }
    }
  }, [doCleanup, acquireWakeLock])

  // ── Keyboard handlers for sim mode ────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'sim') return

    const PREVENT = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when focus is in a text field
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      keysDownRef.current.add(e.key)

      // Q: advance 1 NM immediately along current heading
      if (e.key === 'q' || e.key === 'Q') {
        e.preventDefault()
        const s = simRef.current
        if (!s) return
        const { lat, lng } = advancePosition(s.lat, s.lng, s.trackDeg, 1)
        s.lat = lat
        s.lng = lng
        setPosition({ lat: s.lat, lng: s.lng, altFt: s.altFt, speedKts: s.speedKts, trackDeg: s.trackDeg, accuracy: 0 })
      }

      if (PREVENT.has(e.key)) e.preventDefault()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      keysDownRef.current.delete(e.key)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup',   onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup',   onKeyUp)
    }
  }, [mode])

  // ── Sim teleport (drag-to-reposition, called from MapView) ───────────────
  const teleport = useCallback((lat: number, lng: number) => {
    if (modeRef.current !== 'sim') return
    const s = simRef.current
    if (!s) return
    s.lat = lat
    s.lng = lng
    setPosition(p => p ? { ...p, lat, lng } : null)
  }, [])

  // ── Sim click-to-navigate (called from MapView on map click in sim mode) ─
  const setSimTarget = useCallback((lat: number, lng: number) => {
    if (modeRef.current !== 'sim') return
    const s = simRef.current
    if (!s) return
    s.targetLat = lat
    s.targetLng = lng
  }, [])

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => { doCleanup() }
  }, [doCleanup])

  return { mode, position, startGps, startSim, startExt, stop, teleport, setSimTarget }
}
