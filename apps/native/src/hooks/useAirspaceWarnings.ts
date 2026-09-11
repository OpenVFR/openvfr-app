/**
 * useAirspaceWarnings (native) — proactive airspace penetration alerts.
 *
 * Identical logic to the web hook (src/hooks/useAirspaceWarnings.ts).
 * Differences:
 *   - Fetches from getTileUrls().airspace (absolute URL via adb reverse or prod)
 *   - Module-level GeoJSON cache (shared across renders, survives hot reload)
 *   - pointInPolygon + advancePosition imported from @open-vfr/shared
 *
 * Algorithm:
 *   1. Horizontal check: is the aircraft (or its lookahead path) inside the
 *      polygon AND vertically within the airspace band?
 *   2. Vertical closure: is the aircraft climbing into the floor or descending
 *      through the ceiling of an airspace it is horizontally inside/approaching?
 *
 * Severity:
 *   red    — Restricted (R) / TRA
 *   yellow — Class C / D (CTR, TMA, CTA)
 *   blue   — Class E, G, RMZ, ATZ, activity areas
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { pointInPolygon } from '@open-vfr/shared/airspaceGeometry'
import { advancePosition } from '@open-vfr/shared/routeCalc'
import { getTileUrls } from '../config'

// ── Config ────────────────────────────────────────────────────────────────────
const LOOKAHEAD_MIN_SPEED   = 60
const LOOKAHEAD_SAMPLES     = 5
const DISMISS_REARM_MS      = 5 * 60_000
export const DEFAULT_LOOKAHEAD_MIN = 5

// ── Types ─────────────────────────────────────────────────────────────────────
export type WarningSeverity = 'red' | 'yellow' | 'blue'

export type AirspaceAlert = {
  key:      string
  name:     string
  cls:      string
  type:     string
  lower:    string
  upper:    string
  lower_ft: number
  upper_ft: number
  severity: WarningSeverity
  inside:   boolean
  verticalClosure?: 'floor' | 'ceiling'
  gapFt?:           number
}

type AirspaceFeature = {
  name: string; cls: string; type: string
  lower: string; upper: string
  lower_ft: number; upper_ft: number
  geometry: { type: 'Polygon'; coordinates: number[][][] }
           | { type: 'MultiPolygon'; coordinates: number[][][][] }
}

function getSeverity(cls: string): WarningSeverity {
  if (cls === 'R' || cls === 'TRA')   return 'red'
  if (cls === 'C' || cls === 'D')     return 'yellow'
  return 'blue'
}

// Module-level cache
let _features: AirspaceFeature[] | null = null
let _loading = false
const _listeners: Array<(f: AirspaceFeature[]) => void> = []

function loadOnce(cb: (f: AirspaceFeature[]) => void) {
  if (_features) { cb(_features); return }
  _listeners.push(cb)
  if (_loading) return
  _loading = true
  fetch(getTileUrls().airspace)
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: AirspaceFeature[] = []
      for (const f of fc.features) {
        const g = f.geometry
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
        const p = f.properties as Record<string, unknown>
        const cls = String(p.class ?? ''); const type = String(p.type ?? '')
        if (!cls && !type) continue
        arr.push({
          name:     String(p.name     ?? ''),
          cls,  type,
          lower:    String(p.lower    ?? ''),
          upper:    String(p.upper    ?? ''),
          lower_ft: Number(p.lower_ft ?? 0),
          upper_ft: Number(p.upper_ft ?? 99900),
          geometry: g as AirspaceFeature['geometry'],
        })
      }
      _features = arr
      _listeners.forEach(l => l(arr))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useAirspaceWarnings(
  position:     GpsPosition | null,
  lookaheadMin: number = DEFAULT_LOOKAHEAD_MIN,
  verticalFt:   number = 500,
): { alerts: AirspaceAlert[]; dismiss: (key: string) => void } {
  const [features, setFeatures] = useState<AirspaceFeature[]>([])
  const [alerts,   setAlerts]   = useState<AirspaceAlert[]>([])
  const dismissedRef  = useRef<Map<string, number>>(new Map())
  const prevAltRef    = useRef<{ altFt: number; ts: number } | null>(null)

  useEffect(() => { loadOnce(setFeatures) }, [])

  useEffect(() => {
    if (!position || features.length === 0) { setAlerts([]); return }

    const { lat, lng, altFt, speedKts, trackDeg } = position
    const now = Date.now()

    const prev = prevAltRef.current
    const climbRateFpm = (prev && now - prev.ts > 1000)
      ? (altFt - prev.altFt) / ((now - prev.ts) / 60_000)
      : 0
    prevAltRef.current = { altFt, ts: now }

    const speedForLook = Math.max(speedKts, LOOKAHEAD_MIN_SPEED)
    const lookDistNm   = (lookaheadMin / 60) * speedForLook
    const ahead = Array.from({ length: LOOKAHEAD_SAMPLES }, (_, i) =>
      advancePosition(lat, lng, trackDeg, lookDistNm * ((i + 1) / LOOKAHEAD_SAMPLES)),
    )

    const found: AirspaceAlert[] = []

    for (const f of features) {
      const altInBand = altFt >= f.lower_ft && altFt <= f.upper_ft

      if (altInBand) {
        const key = `${f.name}::${f.cls}`
        const dismissed = dismissedRef.current.get(key)
        if (dismissed !== undefined && now - dismissed < DISMISS_REARM_MS) continue

        const insideCurrent = pointInPolygon(lat, lng, f.geometry)
        const insideAhead   = !insideCurrent && ahead.some(p => pointInPolygon(p.lat, p.lng, f.geometry))
        if (!insideCurrent && !insideAhead) continue

        found.push({ key, name: f.name, cls: f.cls, type: f.type,
          lower: f.lower, upper: f.upper, lower_ft: f.lower_ft, upper_ft: f.upper_ft,
          severity: getSeverity(f.cls), inside: insideCurrent })
        continue
      }

      // Vertical closure — only if horizontally inside/approaching
      const horizMatch = pointInPolygon(lat, lng, f.geometry) ||
        ahead.some(p => pointInPolygon(p.lat, p.lng, f.geometry))
      if (!horizMatch) continue

      // Floor: time-based projection OR within verticalFt buffer
      if (altFt < f.lower_ft) {
        const timeBasedTrigger = climbRateFpm > 100 &&
          altFt + climbRateFpm * lookaheadMin >= f.lower_ft
        const bufferTrigger = verticalFt > 0 && (f.lower_ft - altFt) <= verticalFt
        if (timeBasedTrigger || bufferTrigger) {
          const key = `${f.name}::${f.cls}::floor`
          const dismissed = dismissedRef.current.get(key)
          if (dismissed === undefined || now - dismissed >= DISMISS_REARM_MS) {
            found.push({ key, name: f.name, cls: f.cls, type: f.type,
              lower: f.lower, upper: f.upper, lower_ft: f.lower_ft, upper_ft: f.upper_ft,
              severity: getSeverity(f.cls), inside: false,
              verticalClosure: 'floor', gapFt: Math.round(f.lower_ft - altFt) })
          }
        }
      }

      // Ceiling: time-based projection OR within verticalFt buffer
      if (altFt > f.upper_ft) {
        const timeBasedTrigger = climbRateFpm < -100 &&
          altFt + climbRateFpm * lookaheadMin <= f.upper_ft
        const bufferTrigger = verticalFt > 0 && (altFt - f.upper_ft) <= verticalFt
        if (timeBasedTrigger || bufferTrigger) {
          const key = `${f.name}::${f.cls}::ceiling`
          const dismissed = dismissedRef.current.get(key)
          if (dismissed === undefined || now - dismissed >= DISMISS_REARM_MS) {
            found.push({ key, name: f.name, cls: f.cls, type: f.type,
              lower: f.lower, upper: f.upper, lower_ft: f.lower_ft, upper_ft: f.upper_ft,
              severity: getSeverity(f.cls), inside: false,
              verticalClosure: 'ceiling', gapFt: Math.round(altFt - f.upper_ft) })
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

    setAlerts(found)
  }, [position, features, lookaheadMin])

  const dismiss = useCallback((key: string) => {
    dismissedRef.current.set(key, Date.now())
    setAlerts(prev => prev.filter(a => a.key !== key))
  }, [])

  return { alerts, dismiss }
}
