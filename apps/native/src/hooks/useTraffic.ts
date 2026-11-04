/**
 * useTraffic (native) — polls /api/traffic/latest every 70 s and dead-reckons
 * aircraft positions at 2 s intervals between polls. Right after the layer is
 * turned on the server's feeds may still be waking up: while it answers
 * `fresh: false` the hook asks again sooner (10 s, doubling up to the normal
 * 70 s), see the poll effect.
 *
 * Mirrors the web useTraffic hook but uses polling instead of SSE.
 *
 * Why polling and not SSE:
 *   React Native (New Architecture / Bridgeless) has no built-in EventSource.
 *   Polyfills exist (react-native-sse, react-native-event-source) but add native
 *   module complexity and have had reliability issues with the New Architecture.
 *   Polling at 70 s is functionally equivalent here because the server only
 *   updates the traffic batch every 65 s (one OpenSky API call). There is no
 *   benefit to a persistent connection when data changes at most once per minute.
 *
 * Future improvement — if real-time updates become needed (e.g. < 10 s refresh):
 *   1. Replace with SSE via react-native-sse:
 *        import EventSource from 'react-native-sse'
 *        const es = new EventSource(`${API_BASE}/api/traffic/stream`)
 *        es.addEventListener('message', handler)
 *   2. Or add a WebSocket endpoint to the server and use the built-in
 *      WebSocket API (available in RN without polyfills).
 *   Both keep the same TrafficBatch JSON shape from the server.
 *
 * Battery note: polling is BETTER than SSE for battery on mobile — no persistent
 * TCP connection means the radio can enter low-power idle between polls.
 * SSE requires keepalive packets every 30 s regardless of data frequency.
 *
 * Returns a GeoJSON FeatureCollection ready to drop into a MapLibre source.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { FeatureCollection, Feature, Point } from 'geojson'
import { TRAFFIC_BASE } from '../config'
import { authHeaders } from '../utils/authClient'
import { selectTrafficIcon } from '../utils/trafficIcons'
import { trafficOnGround, trafficAltitudeM } from '@open-vfr/shared/trafficState'

// ── Types (mirrors server TrafficState) ───────────────────────────────────────

interface RawState {
  icao24:      string
  callsign:    string | null
  lat:         number | null
  lon:         number | null
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

interface TrafficBatch {
  polledAt: number
  states:   RawState[]
  /** Server's own verdict (its clock): built from live feeds. Absent from
   *  older servers -- treated as fresh (plain 70 s polling, as before). */
  fresh?:   boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 70_000   // slightly above server's 65 s OpenSky poll
/** Next try while the server has no fresh data (feeds just woke up, or offline). */
/** First retry while the server has no fresh data (feeds waking up, or
 *  offline); doubles each time up to POLL_INTERVAL_MS. */
const RETRY_INTERVAL_MS = 10_000
const STALE_S           = 180
// 2 s, not 1 s: every traffic source update makes MapLibre redraw at display
// rate for ~0.65 s, and a target at 120 kt moves only ~120 m in 2 s.
const DEAD_RECKON_MS    = 2_000
const EARTH_R_M         = 6_371_008.8

// ── Dead-reckoning ────────────────────────────────────────────────────────────

function advancePosition(
  lat: number, lon: number,
  velocityMs: number, trackDeg: number, dtS: number,
): [number, number] {
  const d = (velocityMs * dtS) / EARTH_R_M
  const brng = (trackDeg * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lon1 = (lon * Math.PI) / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  )
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  )
  return [lat2 * 180 / Math.PI, ((lon2 * 180 / Math.PI) + 540) % 360 - 180]
}

function urgency(
  lat: number, lon: number, relAltFt: number | null,
  ownLat: number | null, ownLon: number | null,
): 0 | 1 | 2 | 3 {
  if (ownLat == null || ownLon == null) return 0
  const dLat = (lat - ownLat) * Math.PI / 180
  const dLon = (lon - ownLon) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(ownLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  const distNm = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065
  const absRel = relAltFt != null ? Math.abs(relAltFt) : 99999
  if (distNm < 1 && absRel < 500)  return 3
  if (distNm < 2 && absRel < 1000) return 2
  if (distNm < 3 && absRel < 3000) return 1
  return 0
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface Options {
  enabled:   boolean
  ownAltFt:  number | null
  /** Hide targets further than this above/below own altitude; 0 = show all. */
  vertFilterFt?: number
  ownLat?:   number | null
  ownLon?:   number | null
}

export function useTraffic({ enabled, ownAltFt, vertFilterFt = 0, ownLat = null, ownLon = null }: Options): FeatureCollection {
  const batchRef    = useRef<TrafficBatch | null>(null)
  // Device-clock unix seconds when batchRef's batch arrived: positions are
  // dead-reckoned on this clock, so server/device clock skew does not matter.
  const receivedAtRef = useRef(0)
  const [fc, setFc] = useState<FeatureCollection>({ type: 'FeatureCollection', features: [] })
  // Own position via refs so a GPS fix does not tear down and restart the
  // dead-reckon timer (that used to happen on every fix, i.e. ~1 Hz, which
  // starved / jittered the timer).
  const ownRef = useRef({ ownAltFt, ownLat, ownLon, vertFilterFt })
  ownRef.current = { ownAltFt, ownLat, ownLon, vertFilterFt }

  // ── Poll server ───────────────────────────────────────────────────────────
  /** True when the server returned a batch built recently (live traffic). */
  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch(`${TRAFFIC_BASE}/api/traffic/latest`, { headers: await authHeaders() })
      if (!r.ok) return false
      const data = await r.json() as TrafficBatch
      if (data.polledAt > 0) { batchRef.current = data; receivedAtRef.current = Date.now() / 1000 }
      // Freshness is the server's call (its clock, its poll interval): no
      // device clock skew involved.
      return data.polledAt > 0 && data.fresh !== false
    } catch { return false /* server offline -- keep the last batch */ }
  }, [])

  useEffect(() => {
    if (!enabled) {
      batchRef.current = null
      setFc({ type: 'FeatureCollection', features: [] })
      return
    }
    // Retry soon until a fresh batch arrives, then every POLL_INTERVAL_MS.
    // The server's feeds sleep while nobody watches: the first request after
    // turning the layer on can come back empty or hours old, and waiting the
    // full interval for the next try looked like a layer that never loads.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let retryMs = RETRY_INTERVAL_MS
    const run = async () => {
      const fresh = await poll()
      if (cancelled) return
      // Stale or failed: 10 s, 20 s, 40 s, then the normal interval -- a
      // server that can't produce (feeds down) is not hammered.
      const next = fresh ? POLL_INTERVAL_MS : Math.min(retryMs, POLL_INTERVAL_MS)
      retryMs = fresh ? RETRY_INTERVAL_MS : retryMs * 2
      timer = setTimeout(run, next)
    }
    void run()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [enabled, poll])

  // ── Dead-reckon at 2 s ────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      const batch = batchRef.current
      if (!batch) return
      const { ownAltFt, ownLat, ownLon, vertFilterFt } = ownRef.current
      const nowS = Date.now() / 1000
      const features: Feature<Point>[] = []

      for (const s of batch.states) {
        if (!s.lat || !s.lon) continue
        // Seconds since the position was measured: its age when the batch
        // was built (the batch is rebuilt every few seconds, an OpenSky
        // position only once per poll) plus the time since it arrived.
        const dt = Math.max(0, batch.polledAt - (s.posTime ?? s.lastContact ?? batch.polledAt))
          + Math.max(0, nowS - receivedAtRef.current)
        // Too old to extrapolate: the aircraft may be anywhere by now.
        if (dt > STALE_S) continue

        let [lat, lon] = [s.lat, s.lon]
        const velMs = s.velocityMs ?? 0
        // Ground flag only while slow: portable ADS-B units in ultralights
        // and gyroplanes guess air/ground from speed (see trafficOnGround).
        const onGround = trafficOnGround(s.onGround, s.velocityMs != null ? s.velocityMs * 1.944 : null)
        // No track (some OGN targets): leave it where it was heard instead
        // of moving it due north.
        if (velMs > 0 && s.trackDeg != null && !onGround) {
          ;[lat, lon] = advancePosition(lat, lon, velMs, s.trackDeg, dt)
        }

        // GNSS altitude when known: comparable with own GPS altitude, unlike
        // pressure altitude (off by ~30 ft per hPa of QNH difference).
        const altM     = trafficAltitudeM(s.altM, s.geoAltM)
        const altFt    = altM != null ? altM * 3.281 : null
        const relAltFt = altFt != null && ownAltFt != null ? altFt - ownAltFt : null
        if (vertFilterFt > 0 && relAltFt != null && Math.abs(relAltFt) > vertFilterFt) continue
        const urg      = urgency(lat, lon, relAltFt, ownLat, ownLon)

        features.push({
          type:     'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            icao24:    s.icao24,
            callsign:  s.callsign?.trim() || null,
            altFt:     altFt != null ? Math.round(altFt) : null,
            speedKts:  s.velocityMs != null ? Math.round(s.velocityMs * 1.944) : null,
            trackDeg:  s.trackDeg != null ? Math.round(s.trackDeg) : null,
            vertFpm:   s.vertRateMs != null ? Math.round(s.vertRateMs * 197) : null,
            onGround,
            relAltFt:  relAltFt != null ? Math.round(relAltFt) : null,
            urgency:   urg,
            category:  s.category,
            source:    s.source,
            // iconId pre-computed here (not in AviationMap) so the symbol
            // layer's icon-image expression stays a plain ['get','iconId']
            // -- mirrors web's MapView.tsx doing the same selectTrafficIcon()
            // call before handing features to the GeoJSON source.
            iconId:    selectTrafficIcon(s.category, s.velocityMs != null ? Math.round(s.velocityMs * 1.944) : 0),
          },
        })
      }

      // Empty -> empty: keep the old object so MapScreen does not re-render
      // and the map source is not re-uploaded every second for nothing.
      setFc(prev => (features.length === 0 && prev.features.length === 0)
        ? prev
        : { type: 'FeatureCollection', features })
    }, DEAD_RECKON_MS)
    return () => clearInterval(timer)
  }, [enabled])

  return fc
}
