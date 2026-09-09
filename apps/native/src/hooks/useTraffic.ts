/**
 * useTraffic (native) — polls /api/traffic/latest every 70 s and dead-reckons
 * aircraft positions at 1 s intervals between polls.
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

// ── Types (mirrors server TrafficState) ───────────────────────────────────────

interface RawState {
  icao24:      string
  callsign:    string | null
  lat:         number | null
  lon:         number | null
  altM:        number | null
  velocityMs:  number | null
  trackDeg:    number | null
  vertRateMs:  number | null
  onGround:    boolean
  lastContact: number | null
  category:    number | null
}

interface TrafficBatch {
  polledAt: number
  states:   RawState[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 70_000   // slightly above server's 65 s OpenSky poll
const STALE_S           = 180
const DEAD_RECKON_MS    = 1_000
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
  ownLat?:   number | null
  ownLon?:   number | null
}

export function useTraffic({ enabled, ownAltFt, ownLat = null, ownLon = null }: Options): FeatureCollection {
  const batchRef    = useRef<TrafficBatch | null>(null)
  const [fc, setFc] = useState<FeatureCollection>({ type: 'FeatureCollection', features: [] })

  // ── Poll server ───────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${TRAFFIC_BASE}/api/traffic/latest`, { headers: await authHeaders() })
      if (!r.ok) return
      const data = await r.json() as TrafficBatch
      if (data.polledAt > 0) batchRef.current = data
    } catch { /* server offline — keep last batch */ }
  }, [])

  useEffect(() => {
    if (!enabled) {
      batchRef.current = null
      setFc({ type: 'FeatureCollection', features: [] })
      return
    }
    poll()
    const pollTimer = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(pollTimer)
  }, [enabled, poll])

  // ── Dead-reckon at 1 s ────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      const batch = batchRef.current
      if (!batch) return
      const nowS = Date.now() / 1000
      const features: Feature<Point>[] = []

      for (const s of batch.states) {
        if (!s.lat || !s.lon) continue
        if (s.lastContact && nowS - s.lastContact > STALE_S) continue

        const dt = nowS - batch.polledAt
        let [lat, lon] = [s.lat, s.lon]
        const velMs = s.velocityMs ?? 0
        const trk   = s.trackDeg   ?? 0
        if (velMs > 0 && trk != null && !s.onGround) {
          ;[lat, lon] = advancePosition(lat, lon, velMs, trk, dt)
        }

        const altFt    = s.altM != null ? s.altM * 3.281 : null
        const relAltFt = altFt != null && ownAltFt != null ? altFt - ownAltFt : null
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
            onGround:  s.onGround,
            relAltFt:  relAltFt != null ? Math.round(relAltFt) : null,
            urgency:   urg,
          },
        })
      }

      setFc({ type: 'FeatureCollection', features })
    }, DEAD_RECKON_MS)
    return () => clearInterval(timer)
  }, [enabled, ownAltFt, ownLat, ownLon])

  return fc
}
