/**
 * src/hooks/useTraffic.ts
 *
 * SSE client that connects to GET /api/traffic/stream and returns a
 * live array of TrafficTarget features suitable for a MapLibre GeoJSON source.
 *
 * Architecture (Option A — shared server-side poll):
 *  - One SSE connection per browser tab
 *  - Server polls OpenSky once per ~65 s for the whole region, broadcasts to all clients
 *  - Client dead-reckons each target's position at 1 s intervals between batches:
 *      Δt = now − polledAt
 *      d  = velocity_ms × Δt (metres)  →  converted to degrees lat/lon
 *      alt = altM + vertRate_ms × Δt
 *  - Targets last seen > STALE_S seconds ago are removed
 *  - No-op when traffic is not available on the server (graceful silence)
 */

import { useEffect, useRef, useState } from 'react'
import { API_BASE_URL } from '../utils/env'

// ── Types exported to consumers ───────────────────────────────────────────────

export interface TrafficTarget {
  /** ICAO 24-bit transponder address (lowercase hex). */
  icao24:    string
  callsign:  string | null
  lat:       number
  lon:       number
  /** Barometric altitude in feet. */
  altFt:     number
  /** Ground speed in knots. */
  speedKts:  number
  /** True track degrees clockwise from north. */
  trackDeg:  number
  /** Vertical rate in feet per minute (+climb, −descend). */
  vertFpm:   number
  onGround:  boolean
  /** Altitude difference from ownship (feet). Positive = above. Null when no GPS fix. */
  relAltFt:  number | null
  /** ICAO ADS-B emitter category (0–19). Null if not reported. */
  category:  number | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Remove targets not seen in this many seconds. */
const STALE_S = 180

/** If no SSE message arrives within this many seconds, clear all targets (server offline). */
const WATCHDOG_S = 130

/** Earth radius in metres. */
const EARTH_R_M = 6_371_008.8

// ── Internal state vector (raw from server) ────────────────────────────────

interface RawState {
  icao24:      string
  callsign:    string | null
  lat:         number
  lon:         number
  altM:        number | null
  velocityMs:  number | null
  trackDeg:    number | null
  vertRateMs:  number | null
  onGround:    boolean
  lastContact: number | null
  category:    number | null
}

interface StoredTarget {
  raw:       RawState
  /** Unix seconds when this raw state was snapshotted by the server. */
  polledAt:  number
}

// ── Dead-reckoning helper ─────────────────────────────────────────────────────

function deadReckon(stored: StoredTarget, nowS: number, ownAltFt: number | null): TrafficTarget {
  const { raw, polledAt } = stored
  const dt = Math.max(0, nowS - polledAt)  // seconds since poll

  // ── Altitude first — needed to detect stale onGround=false after landing ──
  // Freeze altitude for transponder-reported ground targets; dead-reckon otherwise.
  const altM = raw.onGround
    ? (raw.altM ?? 0)
    : (raw.altM ?? 0) + (raw.vertRateMs ?? 0) * dt
  // Clamp to 0 ft for nominally-airborne targets: OpenSky sometimes keeps
  // onGround=false for a full poll interval after touchdown. The descent vert-rate
  // drives the extrapolated altitude negative; clamp detects that the aircraft
  // has effectively landed.
  const altFt = Math.max(raw.onGround ? -9999 : 0, altM / 0.3048)

  // Treat as on-ground if the transponder says so OR if dead-reckoning has
  // driven altitude to 0 (aircraft has landed; transponder not yet updated).
  const effectivelyOnGround = raw.onGround || altFt <= 0

  // ── Position extrapolation (airborne only) ────────────────────────────────
  let lat = raw.lat
  let lon = raw.lon
  const vel = raw.velocityMs ?? 0
  const trk = raw.trackDeg  ?? 0
  if (vel > 0.5 && !effectivelyOnGround) {
    const d = (vel * dt) / EARTH_R_M  // angular distance radians
    const trkRad = trk * Math.PI / 180
    const lat1   = lat  * Math.PI / 180
    const lon1   = lon  * Math.PI / 180
    const lat2   = Math.asin(
      Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(trkRad),
    )
    const lon2   = lon1 + Math.atan2(
      Math.sin(trkRad) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )
    lat = lat2 * 180 / Math.PI
    lon = lon2 * 180 / Math.PI
  }

  const speedKts = vel / 0.5144
  const vertFpm  = effectivelyOnGround ? 0 : (raw.vertRateMs ?? 0) / 0.3048 * 60
  const relAltFt = ownAltFt !== null ? Math.round(altFt - ownAltFt) : null

  return {
    icao24:   raw.icao24,
    callsign: raw.callsign,
    lat,
    lon,
    altFt:    Math.round(altFt),
    speedKts: Math.round(speedKts),
    trackDeg: Math.round(trk),
    vertFpm:  Math.round(vertFpm),
    onGround: effectivelyOnGround,
    relAltFt,
    category: raw.category,
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseTrafficOptions {
  /** Current ownship GPS altitude in feet. Used to compute relative altitude labels. */
  ownAltFt?: number | null
  /** Whether traffic should be active (e.g. layer toggle). Disconnects SSE when false. */
  enabled?: boolean
}

export function useTraffic(opts: UseTrafficOptions = {}): TrafficTarget[] {
  const { ownAltFt = null, enabled = true } = opts

  // Ref so dead-reckoning loop always sees latest ownAlt without re-running effect
  const ownAltRef = useRef(ownAltFt)
  useEffect(() => { ownAltRef.current = ownAltFt }, [ownAltFt])

  // Map from icao24 → stored target (raw state + polledAt)
  const storeRef = useRef(new Map<string, StoredTarget>())

  const [targets, setTargets] = useState<TrafficTarget[]>([])

  // Whether the server has traffic configured at all
  const availableRef = useRef<boolean | null>(null)

  useEffect(() => {
    if (!enabled) { setTargets([]); return }

    let evtSource: EventSource | null = null
    let reckTimer: ReturnType<typeof setInterval> | null = null
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function resetWatchdog() {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = setTimeout(() => {
        // No message in WATCHDOG_S seconds — server is offline; clear stale targets
        if (!destroyed) {
          storeRef.current.clear()
          setTargets([])
        }
      }, WATCHDOG_S * 1000)
    }

    // Check availability before opening SSE
    fetch(`${API_BASE_URL}/api/traffic/config`)
      .then(r => r.json())
      .then((cfg: { available: boolean }) => {
        if (destroyed) return
        availableRef.current = cfg.available
        if (!cfg.available) return  // graceful silence — no OpenSky credentials configured

        // Open SSE stream
        evtSource = new EventSource(`${API_BASE_URL}/api/traffic/stream`)
        resetWatchdog()

        evtSource.onmessage = (ev) => {
          if (destroyed) return
          resetWatchdog()  // received a message — server is alive
          try {
            const batch = JSON.parse(ev.data) as {
              polledAt: number
              states: RawState[]
            }
            const polledAt = batch.polledAt
            const store = storeRef.current

            for (const s of batch.states) {
              if (s.lat == null || s.lon == null) continue
              store.set(s.icao24, { raw: s, polledAt })
            }

            // Remove targets not in this batch that are now stale
            const nowS = Date.now() / 1000
            for (const [id, stored] of store) {
              if (nowS - stored.polledAt > STALE_S) store.delete(id)
            }
          } catch { /* ignore malformed events */ }
        }

        evtSource.onerror = () => {
          // If EventSource was explicitly closed (readyState CLOSED), clear targets
          // and stop — browser will not auto-reconnect from a CLOSED state.
          if (evtSource?.readyState === EventSource.CLOSED) {
            storeRef.current.clear()
            if (!destroyed) setTargets([])
          }
          // Otherwise (readyState CONNECTING) the browser auto-reconnects — do nothing.
        }

        // 1 s dead-reckoning render loop
        reckTimer = setInterval(() => {
          if (destroyed) return
          const nowS  = Date.now() / 1000
          const store = storeRef.current
          const result: TrafficTarget[] = []
          for (const [, stored] of store) {
            if (nowS - stored.polledAt > STALE_S) continue
            result.push(deadReckon(stored, nowS, ownAltRef.current))
          }
          setTargets(result)
        }, 1000)
      })
      .catch(() => {
        // Server unreachable or not running — stay silent; no error UI
      })

    return () => {
      destroyed = true
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
      if (evtSource) { evtSource.close(); evtSource = null }
      if (reckTimer) { clearInterval(reckTimer); reckTimer = null }
      storeRef.current.clear()
      setTargets([])
    }
  }, [enabled])

  return targets
}
