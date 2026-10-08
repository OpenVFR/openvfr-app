/**
 * usePositionAlerts (native) — combined replacement for what used to be four
 * separate hooks, each with its own position-tick useEffect + setState:
 *   - useAirspaceWarnings      (proactive penetration/closure alerts)
 *   - useObstructionWarnings   (fixed-obstacle proximity)
 *   - useAirfieldProximity     (unplanned-aerodrome proximity)
 *   - useAirspaceNotifications (silent entry/exit toasts)
 *
 * Why combined: each of the four was already individually guarded (a
 * last-committed-signature check that skips setState when nothing actually
 * changed for THAT hook — see git history on the four originals). That
 * fixed the single-Class-C-transition repro. It did NOT fix two Class C
 * airspaces transitioning simultaneously: that tick genuinely changes both
 * useAirspaceWarnings' alerts AND useAirspaceNotifications' notifications
 * at once, so MapScreen still took two independent setState-triggered
 * commits for one GPS tick — correct behavior per-hook, but every
 * additional independent position-driven hook in MapScreen (this file used
 * to have four; MapScreen also runs useNearbyFrequencies/useWind/
 * useAltitudeSource/useTerrainElevation/useLivePlog on the same position)
 * stacks another potential commit onto the same tick. Under Simulate
 * mode's own per-tick loop that stacking was enough to trip React's
 * "Maximum update depth exceeded" safety limit — not an infinite loop in
 * any single hook, just too many legitimately-independent commits queued
 * from one input change. Consolidating these four into one evaluation
 * pass + one setState (only when at least one category actually changed)
 * cuts the worst-case commits-per-tick from this group from 4 to 1.
 *
 * Bonus: useAirspaceWarnings and useAirspaceNotifications previously each
 * fetched getTileUrls().airspace independently (two separate GeoJSON
 * parses of the same file, module-scope-cached in one but not the other).
 * Combined into a single fetch+cache here.
 *
 * All four hooks' individual algorithms, thresholds, and dismiss/re-arm
 * semantics are preserved exactly — see each concept's inline comments
 * below for the original hook it was extracted from.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { pointInPolygon } from '@open-vfr/shared/airspaceGeometry'
import { lookaheadPath, accuracyRing } from '@open-vfr/shared/lookahead'
import { dropCoveredSubAreas } from '@open-vfr/shared/subAreas'
import { airspaceDisplayClass } from '@open-vfr/shared/airspaceColors'
import { getTileUrls } from '../config'
import { altitudeForLimit, effectiveLimitFt, limitMarginFt, insideBand } from '@open-vfr/shared/airspaceAltitude'

// ── Airspace warnings config (useAirspaceWarnings) ─────────────────────────
const LOOKAHEAD_MIN_SPEED = 60
const AIRSPACE_REARM_MS   = 5 * 60_000
export const DEFAULT_LOOKAHEAD_MIN = 5

// ── Obstruction config (useObstructionWarnings) ────────────────────────────
const OBS_WARN_RADIUS_NM     = 1.0
const OBS_VERTICAL_BUFFER_FT = 500
const OBS_MAX_ALERTS         = 5
const OBS_REARM_MS           = 5 * 60_000
const NM_PER_DEG_LAT         = 60.0

// ── Airfield proximity config (useAirfieldProximity) ───────────────────────
const AF_LATERAL_NM    = 1.0
const AF_VERTICAL_FT   = 1_500
const AF_REARM_MS      = 5 * 60_000
const AF_DEG_PER_NM    = 1 / 60
const AF_ROUTE_MATCH_NM = 0.5

// ── Notification config (useAirspaceNotifications) ─────────────────────────
const NOTIFICATION_TTL_MS = 9_000
const NOTIFICATION_MAX_QUEUE = 8

// ── Shared types ────────────────────────────────────────────────────────────
export type WarningSeverity = 'red' | 'yellow' | 'blue'

export type AirspaceAlert = {
  key: string; name: string; cls: string; type: string
  lower: string; upper: string; lower_ft: number; upper_ft: number
  severity: WarningSeverity; inside: boolean
  verticalClosure?: 'floor' | 'ceiling'; gapFt?: number
}

export type ObstructionAlert = {
  key: string; kind: string; name: string
  elevationFt: number; tipFt: number; distNm: number
}

export type AirfieldProximityAlert = {
  key: string; icao: string; name: string
  distNm: number; elevationFt: number; primaryFreq: string | null
}

export type NotificationDirection = 'entered' | 'left'
export type AirspaceNotification = {
  id: string; name: string; cls: string; type: string
  lower: string; upper: string
  direction: NotificationDirection; severity: WarningSeverity; expiresAt: number
}

function getSeverity(cls: string): WarningSeverity {
  // Follows the usual chart-warning convention: prohibited/restricted/danger and
  // class A red; class B, C, D yellow. E/F are advisory and stay informational (blue).
  if (cls === 'R' || cls === 'TRA' || cls === 'A') return 'red'
  if (cls === 'B' || cls === 'C' || cls === 'D')   return 'yellow'
  return 'blue'
}

// ── Feature record types ────────────────────────────────────────────────────
type AirspaceFeature = {
  key: string; name: string; cls: string; type: string
  lower: string; upper: string; lower_ft: number; upper_ft: number
  geometry: { type: 'Polygon'; coordinates: number[][][] }
           | { type: 'MultiPolygon'; coordinates: number[][][][] }
}
type ObstaclePoint = {
  key: string; lat: number; lng: number
  kind: string; name: string; elevFt: number; tipFt: number
}
type AerodromeFeature = {
  key: string; icao: string; name: string; lat: number; lng: number
  elevationFt: number; primaryFreq: string | null
}

// ── Module-level airspace cache (shared across renders/hot-reload; also
// shared between the two consumers that used to fetch it separately) ──────
let _airspaceFeatures: AirspaceFeature[] | null = null
let _airspaceLoading = false
const _airspaceListeners: Array<(f: AirspaceFeature[]) => void> = []

function loadAirspaceOnce(cb: (f: AirspaceFeature[]) => void) {
  if (_airspaceFeatures) { cb(_airspaceFeatures); return }
  _airspaceListeners.push(cb)
  if (_airspaceLoading) return
  _airspaceLoading = true
  fetch(getTileUrls().airspace)
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: AirspaceFeature[] = []
      for (const f of fc.features) {
        const g = f.geometry
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
        const p = f.properties as Record<string, unknown>
        const type = String(p.type ?? ''); const cls = airspaceDisplayClass(String(p.class ?? ''), type)
        if (!cls && !type) continue
        const name = String(p.name ?? '')
        const lower = String(p.lower ?? ''), upper = String(p.upper ?? '')
        const lower_ft = Number(p.lower_ft ?? 0), upper_ft = Number(p.upper_ft ?? 99900)
        arr.push({
          // Limits are part of the key: same-named sectors (TMA/CTA sectors with
          // different bands) must alert and dismiss independently.
          key: `${name}::${cls}::${lower_ft}-${upper_ft}`, name, cls, type,
          lower, upper, lower_ft, upper_ft,
          geometry: g as AirspaceFeature['geometry'],
        })
      }
      // Parent + lettered sub-areas (ESR121 / ESR121B) are one hazard: warn once.
      const deduped = dropCoveredSubAreas(arr)
      _airspaceFeatures = deduped
      _airspaceListeners.forEach(l => l(deduped))
      _airspaceListeners.length = 0
    })
    .catch(() => { _airspaceLoading = false })
}

function approxDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT
  const cosLat = Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  const dLng = (lng2 - lng1) * NM_PER_DEG_LAT * cosLat
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

export type PositionAlerts = {
  airspaceAlerts:        AirspaceAlert[]
  obstructionAlerts:     ObstructionAlert[]
  airfieldAlerts:        AirfieldProximityAlert[]
  airspaceNotifications: AirspaceNotification[]
  dismissAirspace:        (key: string) => void
  dismissObstruction:     (key: string) => void
  dismissAirfield:        (key: string) => void
  clearAllNotifications:  () => void
}

export type AlertPosition = GpsPosition & {
  /** Pressure altitude (1013.25) for FL limits; absent → QNH/GPS altFt is used for all limits. */
  altStdFt?: number | null
  /** True when altFt rests on an unverified QNH → closure warnings get a wider buffer. */
  altQnhUncertain?: boolean
  /** Ground elevation (ft AMSL) under the aircraft, lifts AGL limits; absent → raw AGL value. */
  terrainFt?: number | null
}

export function usePositionAlerts(
  position:       AlertPosition | null,
  routeWaypoints: RouteWaypoint[],
  lookaheadMin:   number = DEFAULT_LOOKAHEAD_MIN,
  verticalFt:     number = 500,
): PositionAlerts {
  const [airspaceFeatures, setAirspaceFeatures]   = useState<AirspaceFeature[]>([])
  const [obstacleFeatures, setObstacleFeatures]   = useState<ObstaclePoint[]>([])
  const [aerodromeFeatures, setAerodromeFeatures] = useState<AerodromeFeature[]>([])

  const [airspaceAlerts, setAirspaceAlerts]               = useState<AirspaceAlert[]>([])
  const [obstructionAlerts, setObstructionAlerts]         = useState<ObstructionAlert[]>([])
  const [airfieldAlerts, setAirfieldAlerts]               = useState<AirfieldProximityAlert[]>([])
  const [airspaceNotifications, setAirspaceNotifications] = useState<AirspaceNotification[]>([])

  const airspaceDismissedRef    = useRef<Map<string, number>>(new Map())
  const obstructionDismissedRef = useRef<Map<string, number>>(new Map())
  const airfieldDismissedRef    = useRef<Map<string, number>>(new Map())
  const prevAltRef              = useRef<{ altFt: number; ts: number } | null>(null)
  const insideRef               = useRef<Set<string>>(new Set())
  const notifInitializedRef     = useRef(false)

  const airspaceSigRef    = useRef('')
  const obstructionSigRef = useRef('')
  const airfieldSigRef    = useRef('')

  // ── Load each feature set once ──────────────────────────────────────────
  useEffect(() => { loadAirspaceOnce(setAirspaceFeatures) }, [])

  useEffect(() => {
    fetch(getTileUrls().obstacles)
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const pts: ObstaclePoint[] = []
        fc.features.forEach((f, i) => {
          const g = f.geometry as GeoJSON.Point
          const p = f.properties as Record<string, unknown>
          const elevFt  = Number(p['elevation_ft'] ?? 0)
          const heightM = Number(p['height_m']     ?? 0)
          const tipFt   = elevFt + Math.round(heightM * 3.28084)
          const kind    = String(p['kind'] ?? 'other')
          const name    = String(p['name'] ?? '').trim()
          pts.push({ key: name || `obs-${i}`, lat: g.coordinates[1], lng: g.coordinates[0], kind, name, elevFt, tipFt })
        })
        setObstacleFeatures(pts)
      })
      .catch(() => { /* offline-safe */ })
  }, [])

  useEffect(() => {
    fetch(getTileUrls().aerodromes)
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const arr: AerodromeFeature[] = []
        for (const f of fc.features) {
          if (f.geometry.type !== 'Point') continue
          const p        = f.properties as Record<string, unknown>
          const icao     = String(p['icao'] ?? '')
          const name     = String(p['name'] ?? '')
          const elevFt   = Number(p['elevation_ft'] ?? 0)
          const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
          const key = icao || name
          if (!key) continue
          const rawFreqs = p['frequencies']
          const freqs: Array<{ service?: string; freq_mhz?: number }> =
            Array.isArray(rawFreqs) ? rawFreqs
            : typeof rawFreqs === 'string' ? JSON.parse(rawFreqs)
            : []
          const rawContacts = p['contacts']
          const contacts: Array<{ type?: string; address?: string }> =
            Array.isArray(rawContacts) ? rawContacts
            : typeof rawContacts === 'string' ? JSON.parse(rawContacts)
            : []
          const PRIMARY_ORDER = ['TWR', 'AFIS', 'INFO', 'APP', 'GROUND', 'CTAF', 'UNICOM', 'RDO', 'RADIO']
          let primaryFreq: string | null = null
          for (const svc of PRIMARY_ORDER) {
            const match = freqs.find(fq => fq.service === svc && fq.freq_mhz != null)
            if (match) { primaryFreq = match.freq_mhz!.toFixed(3); break }
          }
          if (!primaryFreq && freqs.length > 0 && freqs[0].freq_mhz != null) {
            primaryFreq = freqs[0].freq_mhz!.toFixed(3)
          }
          if (!primaryFreq) {
            const rc = contacts.find(c => c.type === 'RADIO' && c.address)
            if (rc) { const mhz = parseFloat(rc.address!); if (!isNaN(mhz)) primaryFreq = mhz.toFixed(3) }
          }
          arr.push({ key, icao, name, lat, lng, elevationFt: elevFt, primaryFreq })
        }
        setAerodromeFeatures(arr)
      })
      .catch(() => { /* offline-safe */ })
  }, [])

  // ── Prune expired notifications every second (unrelated to position ticks,
  // kept as its own interval — see useAirspaceNotifications.ts original) ───
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setAirspaceNotifications(prev => {
        const next = prev.filter(n => n.expiresAt > now)
        return next.length === prev.length ? prev : next
      })
    }, 1_000)
    return () => clearInterval(timer)
  }, [])

  // ── Single combined evaluation pass per position tick ───────────────────
  // Computes all four categories, then commits at most ONE state update per
  // category that actually changed — but critically, all category updates
  // for this tick are issued synchronously in the same effect invocation,
  // so React 18's automatic batching coalesces them into one commit
  // regardless of how many of the four categories changed.
  useEffect(() => {
    if (!position) {
      if (airspaceSigRef.current !== '') { airspaceSigRef.current = ''; setAirspaceAlerts([]) }
      if (obstructionSigRef.current !== '') { obstructionSigRef.current = ''; setObstructionAlerts([]) }
      if (airfieldSigRef.current !== '') { airfieldSigRef.current = ''; setAirfieldAlerts([]) }
      if (notifInitializedRef.current) {
        insideRef.current = new Set()
        notifInitializedRef.current = false
        setAirspaceNotifications([])
      }
      return
    }

    const { lat, lng, altFt, speedKts, trackDeg, accuracy } = position
    const ownAlt = { qnhFt: altFt, stdFt: position.altStdFt ?? null, qnhUncertain: position.altQnhUncertain === true }
    const terrainFt = position.terrainFt ?? null
    // Per-limit own altitude: FL limits compare on 1013.25, ft MSL limits on QNH.
    const loAlt = (f: AirspaceFeature) => altitudeForLimit(f.lower, ownAlt)
    const hiAlt = (f: AirspaceFeature) => altitudeForLimit(f.upper, ownAlt)
    // Per-limit published value as an altitude: AGL limits lifted by the terrain.
    const loLim = (f: AirspaceFeature) => effectiveLimitFt(f.lower, f.lower_ft, terrainFt)
    const hiLim = (f: AirspaceFeature) => effectiveLimitFt(f.upper, f.upper_ft, terrainFt)
    // Extra closure buffer when the own altitude is not in the limit's reference.
    const loBuf = (f: AirspaceFeature) => verticalFt + limitMarginFt(f.lower, ownAlt)
    const hiBuf = (f: AirspaceFeature) => verticalFt + limitMarginFt(f.upper, ownAlt)
    const now = Date.now()

    // ── Airspace warnings (useAirspaceWarnings algorithm) ─────────────────
    if (airspaceFeatures.length > 0) {
      const prevAlt = prevAltRef.current
      const climbRateFpm = (prevAlt && now - prevAlt.ts > 1000)
        ? (altFt - prevAlt.altFt) / ((now - prevAlt.ts) / 60_000)
        : 0
      prevAltRef.current = { altFt, ts: now }

      const speedForLook = Math.max(speedKts, LOOKAHEAD_MIN_SPEED)
      const lookDistNm   = (lookaheadMin / 60) * speedForLook
      // Projected path (on-track and a 15-degree fan either side) plus the GPS accuracy ring around
      // the fix -- see @open-vfr/shared/lookahead for why both.
      const ahead = [...lookaheadPath(lat, lng, trackDeg, lookDistNm), ...accuracyRing(lat, lng, accuracy)]

      const found: AirspaceAlert[] = []
      for (const f of airspaceFeatures) {
        const altLo = loAlt(f), altHi = hiAlt(f)
        const lowerFt = loLim(f), upperFt = hiLim(f)
        const altInBand = insideBand(altLo, altHi, lowerFt, upperFt, insideRef.current.has(f.key))
        if (altInBand) {
          const key = f.key
          const dismissed = airspaceDismissedRef.current.get(key)
          if (dismissed !== undefined && now - dismissed < AIRSPACE_REARM_MS) continue
          const insideCurrent = pointInPolygon(lat, lng, f.geometry)
          const insideAhead   = !insideCurrent && ahead.some(p => pointInPolygon(p.lat, p.lng, f.geometry))
          if (!insideCurrent && !insideAhead) continue
          found.push({ key, name: f.name, cls: f.cls, type: f.type,
            lower: f.lower, upper: f.upper, lower_ft: f.lower_ft, upper_ft: f.upper_ft,
            severity: getSeverity(f.cls), inside: insideCurrent })
          continue
        }
        const horizMatch = pointInPolygon(lat, lng, f.geometry) ||
          ahead.some(p => pointInPolygon(p.lat, p.lng, f.geometry))
        if (!horizMatch) continue
        if (altLo < lowerFt) {
          const buf = loBuf(f)
          const timeBasedTrigger = climbRateFpm > 100 && altLo + climbRateFpm * lookaheadMin >= lowerFt
          const bufferTrigger = buf > 0 && (lowerFt - altLo) <= buf
          if (timeBasedTrigger || bufferTrigger) {
            const key = `${f.key}::floor`
            const dismissed = airspaceDismissedRef.current.get(key)
            if (dismissed === undefined || now - dismissed >= AIRSPACE_REARM_MS) {
              found.push({ key, name: f.name, cls: f.cls, type: f.type,
                lower: f.lower, upper: f.upper, lower_ft: f.lower_ft, upper_ft: f.upper_ft,
                severity: getSeverity(f.cls), inside: false,
                verticalClosure: 'floor', gapFt: Math.round(lowerFt - altLo) })
            }
          }
        }
        if (altHi > upperFt) {
          const buf = hiBuf(f)
          const timeBasedTrigger = climbRateFpm < -100 && altHi + climbRateFpm * lookaheadMin <= upperFt
          const bufferTrigger = buf > 0 && (altHi - upperFt) <= buf
          if (timeBasedTrigger || bufferTrigger) {
            const key = `${f.key}::ceiling`
            const dismissed = airspaceDismissedRef.current.get(key)
            if (dismissed === undefined || now - dismissed >= AIRSPACE_REARM_MS) {
              found.push({ key, name: f.name, cls: f.cls, type: f.type,
                lower: f.lower, upper: f.upper, lower_ft: f.lower_ft, upper_ft: f.upper_ft,
                severity: getSeverity(f.cls), inside: false,
                verticalClosure: 'ceiling', gapFt: Math.round(altHi - upperFt) })
            }
          }
        }
      }
      found.sort((a, b) => {
        if (a.inside !== b.inside) return a.inside ? -1 : 1
        const sv = { red: 0, yellow: 1, blue: 2 }
        if (sv[a.severity] !== sv[b.severity]) return sv[a.severity] - sv[b.severity]
        return a.lower_ft - b.lower_ft
      })
      const sig = found.map(a => `${a.key}:${a.inside}:${a.verticalClosure ?? ''}:${a.gapFt ?? ''}`).join('|')
      if (sig !== airspaceSigRef.current) {
        airspaceSigRef.current = sig
        setAirspaceAlerts(found)
      }

      // ── Airspace entry/exit notifications (useAirspaceNotifications) ────
      // Hysteresis: once inside, stay inside until clearly out of the band, so
      // an aircraft level at a floor/ceiling does not flap entered/left.
      const prevInside = insideRef.current
      const current = new Set<string>()
      for (const f of airspaceFeatures) {
        if (!insideBand(loAlt(f), hiAlt(f), loLim(f), hiLim(f), prevInside.has(f.key))) continue
        if (pointInPolygon(lat, lng, f.geometry)) current.add(f.key)
      }
      if (!notifInitializedRef.current) {
        insideRef.current = current
        notifInitializedRef.current = true
      } else {
        const fresh: AirspaceNotification[] = []
        for (const key of current) {
          if (!prevInside.has(key)) {
            const f = airspaceFeatures.find(x => x.key === key)
            if (!f) continue
            fresh.push({ id: `${key}::${now}::entered`, name: f.name, cls: f.cls, type: f.type,
              lower: f.lower, upper: f.upper, direction: 'entered', severity: getSeverity(f.cls),
              expiresAt: now + NOTIFICATION_TTL_MS })
          }
        }
        for (const key of prevInside) {
          if (!current.has(key)) {
            const f = airspaceFeatures.find(x => x.key === key)
            if (!f) continue
            fresh.push({ id: `${key}::${now}::left`, name: f.name, cls: f.cls, type: f.type,
              lower: f.lower, upper: f.upper, direction: 'left', severity: getSeverity(f.cls),
              expiresAt: now + NOTIFICATION_TTL_MS })
          }
        }
        insideRef.current = current
        if (fresh.length > 0) {
          setAirspaceNotifications(prev => {
            const freshKeys = new Set(fresh.map(n => n.name + '::' + n.cls + '::' + n.lower + '-' + n.upper))
            const kept = prev.filter(n => !freshKeys.has(n.name + '::' + n.cls + '::' + n.lower + '-' + n.upper))
            return [...fresh, ...kept].slice(0, NOTIFICATION_MAX_QUEUE)
          })
        }
      }
    }

    // ── Obstruction warnings (useObstructionWarnings algorithm) ──────────
    if (obstacleFeatures.length > 0) {
      const found: ObstructionAlert[] = []
      for (const obs of obstacleFeatures) {
        if (Math.abs(obs.lat - lat) > OBS_WARN_RADIUS_NM / NM_PER_DEG_LAT * 1.2) continue
        const distNm = approxDistNm(lat, lng, obs.lat, obs.lng)
        if (distNm > OBS_WARN_RADIUS_NM) continue
        if (altFt > obs.tipFt + OBS_VERTICAL_BUFFER_FT) continue
        const dismissedAt = obstructionDismissedRef.current.get(obs.key)
        if (dismissedAt !== undefined && now - dismissedAt < OBS_REARM_MS) continue
        found.push({ key: obs.key, kind: obs.kind, name: obs.name || obs.kind.replace('_', ' '),
          elevationFt: obs.elevFt, tipFt: obs.tipFt, distNm })
        if (found.length >= OBS_MAX_ALERTS) break
      }
      found.sort((a, b) => a.distNm - b.distNm)
      const sig = found.map(a => `${a.key}:${a.distNm}`).join('|')
      if (sig !== obstructionSigRef.current) {
        obstructionSigRef.current = sig
        setObstructionAlerts(found)
      }
    }

    // ── Airfield proximity (useAirfieldProximity algorithm) ──────────────
    if (aerodromeFeatures.length > 0) {
      const routeOnAero = new Set<string>()
      for (const ad of aerodromeFeatures) {
        for (const wp of routeWaypoints) {
          if (approxDistNm(ad.lat, ad.lng, wp.lat, wp.lng) <= AF_ROUTE_MATCH_NM) {
            routeOnAero.add(ad.key)
            break
          }
        }
      }
      const found: AirfieldProximityAlert[] = []
      for (const ad of aerodromeFeatures) {
        if (routeOnAero.has(ad.key)) continue
        if (Math.abs(lat - ad.lat) > AF_LATERAL_NM * AF_DEG_PER_NM * 1.5) continue
        if (Math.abs(lng - ad.lng) > AF_LATERAL_NM * AF_DEG_PER_NM * 2.5) continue
        const distNm = approxDistNm(lat, lng, ad.lat, ad.lng)
        if (distNm > AF_LATERAL_NM) continue
        if (Math.abs(altFt - ad.elevationFt) > AF_VERTICAL_FT) continue
        const dismissedAt = airfieldDismissedRef.current.get(ad.key)
        if (dismissedAt !== undefined && now - dismissedAt < AF_REARM_MS) continue
        found.push({ key: ad.key, icao: ad.icao, name: ad.name,
          distNm: Math.round(distNm * 10) / 10, elevationFt: ad.elevationFt, primaryFreq: ad.primaryFreq })
      }
      found.sort((a, b) => a.distNm - b.distNm)
      const sig = found.map(a => `${a.key}:${a.distNm}`).join('|')
      if (sig !== airfieldSigRef.current) {
        airfieldSigRef.current = sig
        setAirfieldAlerts(found)
      }
    }
  }, [position, airspaceFeatures, obstacleFeatures, aerodromeFeatures, routeWaypoints, lookaheadMin, verticalFt])

  const dismissAirspace = useCallback((key: string) => {
    airspaceDismissedRef.current.set(key, Date.now())
    setAirspaceAlerts(prev => prev.filter(a => a.key !== key))
  }, [])
  const dismissObstruction = useCallback((key: string) => {
    obstructionDismissedRef.current.set(key, Date.now())
    setObstructionAlerts(prev => prev.filter(a => a.key !== key))
  }, [])
  const dismissAirfield = useCallback((key: string) => {
    airfieldDismissedRef.current.set(key, Date.now())
    setAirfieldAlerts(prev => prev.filter(a => a.key !== key))
  }, [])
  const clearAllNotifications = useCallback(() => setAirspaceNotifications([]), [])

  return {
    airspaceAlerts, obstructionAlerts, airfieldAlerts, airspaceNotifications,
    dismissAirspace, dismissObstruction, dismissAirfield, clearAllNotifications,
  }
}
