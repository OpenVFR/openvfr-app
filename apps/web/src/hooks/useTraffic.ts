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
 *      Δt = now − time the position was measured (state posTime, mapped to
 *           this device's clock via the batch's polledAt so clock skew
 *           between server and device does not matter)
 *      d  = velocity_ms × Δt (metres)  →  converted to degrees lat/lon
 *      alt = GNSS (else pressure) altitude + vertRate_ms × Δt
 *  - Targets last seen, or last positioned, > STALE_S seconds ago are removed
 *  - No-op when traffic is not available on the server (graceful silence)
 */

import { useEffect, useRef, useState } from 'react'
import { API_BASE_URL } from '../utils/env'
import { trafficOnGround, trafficAltitudeM } from '@open-vfr/shared/trafficState'

// ── Types exported to consumers ───────────────────────────────────────────────

export interface TrafficTarget {
  /** ICAO 24-bit transponder address (lowercase hex). */
  icao24:    string
  callsign:  string | null
  lat:       number
  lon:       number
  /** Altitude in feet: GNSS when the feed has it, else pressure altitude. */
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
  /** Which upstream feed this target came from — 'opensky' (ADS-B) or 'ogn' (FLARM/glider network). */
  source:    'opensky' | 'ogn'
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Remove targets not seen in this many seconds. */
const STALE_S = 180

/** If no SSE message arrives within this many seconds, clear all targets (server offline). */
const WATCHDOG_S = 130

/** Longest time a target's vertical rate is extrapolated (seconds). */
const VERT_DR_MAX_S = 30

/** Earth radius in metres. */
const EARTH_R_M = 6_371_008.8

// ── Internal state vector (raw from server) ────────────────────────────────

interface RawState {
  icao24:      string
  callsign:    string | null
  lat:         number
  lon:         number
  altM:        number | null
  /** GNSS altitude metres; absent from older servers. */
  geoAltM?:    number | null
  velocityMs:  number | null
  trackDeg:    number | null
  vertRateMs:  number | null
  onGround:    boolean
  lastContact: number | null
  /** Unix seconds (server clock) the position was measured; absent from older servers. */
  posTime?:    number | null
  category:    number | null
  source:      'opensky' | 'ogn'
}

interface StoredTarget {
  raw:       RawState
  /** Device-clock unix seconds when this target was last in a batch. */
  seenAt:    number
  /** Device-clock unix seconds when its position was measured. */
  posAt:     number
}

/** Gone from the feed, or its last position is too old to extrapolate. */
function isStale(stored: StoredTarget, nowS: number): boolean {
  return nowS - stored.seenAt > STALE_S || nowS - stored.posAt > STALE_S
}

// ── Dead-reckoning helper ─────────────────────────────────────────────────────

function deadReckon(stored: StoredTarget, nowS: number, ownAltFt: number | null): TrafficTarget {
  const { raw, posAt } = stored
  const dt = Math.min(STALE_S, Math.max(0, nowS - posAt))  // seconds since the position was measured

  // On ground only by the reported flag, and only while slow (see
  // trafficOnGround). This used to also count any altitude <= 0 as landed,
  // which hid low airborne traffic: pressure altitude is below 0 near the
  // coast on a high-pressure day, and a missing altitude read as 0.
  const speedKtsRaw = raw.velocityMs != null ? raw.velocityMs / 0.5144 : null
  const effectivelyOnGround = trafficOnGround(raw.onGround, speedKtsRaw)

  // GNSS altitude when known (comparable with own GPS altitude). The
  // vertical rate is extrapolated for VERT_DR_MAX_S at most: a long gap
  // with a descent rate would otherwise put the target far below where it
  // levelled off.
  const baseAltM = trafficAltitudeM(raw.altM, raw.geoAltM) ?? 0
  const altM = effectivelyOnGround
    ? baseAltM
    : baseAltM + (raw.vertRateMs ?? 0) * Math.min(dt, VERT_DR_MAX_S)
  const altFt = altM / 0.3048

  // ── Position extrapolation (airborne only) ────────────────────────────────
  let lat = raw.lat
  let lon = raw.lon
  const vel = raw.velocityMs ?? 0
  const trk = raw.trackDeg  ?? 0
  // No track (some OGN targets): leave it where it was heard instead of
  // moving it due north.
  if (vel > 0.5 && raw.trackDeg != null && !effectivelyOnGround) {
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
    source:   raw.source,
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

  // Map from icao24 → stored target (raw state + when seen / positioned)
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
    // credentials:'include' required for the split-origin production
    // deployment (web app origin calling a separate API origin) -- this endpoint is
    // session-gated (requireSession() in apps/api/src/index.ts), and a
    // cross-origin fetch() does not send the session cookie by default.
    // Without this, the request 401s and the whole traffic layer silently
    // never appears -- indistinguishable from "server has no OpenSky
    // credentials configured" because of the graceful .catch() below.
    fetch(`${API_BASE_URL}/api/traffic/config`, { credentials: 'include' })
      .then(r => r.json())
      .then((cfg: { available: boolean; ognAvailable?: boolean }) => {
        if (destroyed) return
        // Either feed is enough: an OGN-only server (no OpenSky credentials)
        // still streams gliders / FLARM traffic.
        const any = cfg.available || cfg.ognAvailable === true
        availableRef.current = any
        if (!any) return  // graceful silence — no traffic feed configured

        // Open SSE stream. withCredentials:true is EventSource's OWN,
        // separate cross-origin credentials flag -- NOT the same mechanism
        // as fetch()'s credentials:'include' above, and easy to miss since
        // it doesn't share the same option name. Same requirement, same
        // reason: /api/traffic/stream is session-gated, and without this
        // the session cookie is never sent cross-origin, so the stream
        // 401s (silently, same as above -- EventSource surfaces this via
        // onerror, which this code already treats as "stay silent" for the
        // CONNECTING-state auto-reconnect case).
        evtSource = new EventSource(`${API_BASE_URL}/api/traffic/stream`, { withCredentials: true })
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
            const nowS = Date.now() / 1000

            for (const s of batch.states) {
              if (s.lat == null || s.lon == null) continue
              // The batch is rebroadcast every few seconds while an OpenSky
              // position only changes once per poll: dead-reckon from when
              // the position was measured, not from when the batch was sent.
              const ageS = Math.max(0, polledAt - (s.posTime ?? polledAt))
              store.set(s.icao24, { raw: s, seenAt: nowS, posAt: nowS - ageS })
            }

            for (const [id, stored] of store) {
              if (isStale(stored, nowS)) store.delete(id)
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
            if (isStale(stored, nowS)) continue
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
