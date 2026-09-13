/**
 * useAirspaceWarnings — proactive airspace penetration alerts.
 *
 * Loads se-airspace.geojson once on mount. On each position update it:
 *   1. Checks if the aircraft is currently INSIDE any airspace polygon
 *      (and the aircraft altitude is within the vertical limits).
 *   2. Projects the aircraft forward by LOOKAHEAD_MIN minutes at current
 *      ground speed (minimum LOOKAHEAD_MIN_SPEED_KTS) and samples
 *      LOOKAHEAD_SAMPLES evenly-spaced points along that path, checking
 *      if any of them would be inside any airspace. Sampling the path
 *      (rather than just the endpoint) catches narrow airspaces that the
 *      aircraft would cross entirely within the lookahead window, and
 *      oblique approaches where the single endpoint misses laterally.
 *
 * Returns an array of AirspaceAlert objects, sorted by severity (red first).
 * Each alert carries a stable `key` so the banner can animate it in/out.
 *
 * Dismiss: calling dismiss(key) suppresses that airspace+position combo for
 * DISMISS_REARM_MS (5 minutes), after which it will re-fire if still inside.
 *
 * Altitude check: an alert only fires when:
 *   altFt >= lower_ft  AND  altFt <= upper_ft
 * (i.e. the aircraft is vertically inside the airspace volume).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { pointInPolygon } from '@open-vfr/shared/airspaceGeometry'
import { advancePosition } from '@open-vfr/shared/routeCalc'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// ── Config ──────────────────────────────────────────────────────────────────
const LOOKAHEAD_MIN_SPEED   = 60     // assume at least 60 kts when projecting ahead
const LOOKAHEAD_SAMPLES     = 5      // sample points along lookahead path (incl. endpoint)
const DISMISS_REARM_MS      = 5 * 60_000  // 5 minutes
export const DEFAULT_LOOKAHEAD_MIN = 5

// ── Severity classification ─────────────────────────────────────────────────
export type WarningSeverity = 'red' | 'yellow' | 'blue'

const SEVERITY_ORDER: Record<WarningSeverity, number> = { red: 0, yellow: 1, blue: 2 }

function getSeverity(cls: string): WarningSeverity {
  if (cls === 'R' || cls === 'TRA')            return 'red'
  if (cls === 'C' || cls === 'D')              return 'yellow'
  return 'blue'  // E, G, RMZ, ATZ, GLDR, MODEL, CTR…
}

// ── Warning type ────────────────────────────────────────────────────────────
export type AirspaceAlert = {
  /** Stable identifier: airspace name + severity (used as React key + dismiss token). */
  key:      string
  name:     string
  cls:      string
  type:     string
  lower:    string  // human label e.g. "SFC"
  upper:    string  // human label e.g. "FL095"
  lower_ft: number
  upper_ft: number
  severity: WarningSeverity
  /** True = aircraft is currently inside; false = lookahead penetration. */
  inside:   boolean
  /**
   * Present when this is a vertical-closure warning rather than a horizontal
   * penetration warning. 'floor' = climbing into the base of the airspace;
   * 'ceiling' = descending into the top. `gapFt` is the vertical distance
   * remaining to the boundary at the time the alert was generated.
   */
  verticalClosure?: 'floor' | 'ceiling'
  gapFt?:           number
}

// ── Geometry helpers ─────────────────────────────────────────────────────────


// ── Internal airspace record (loaded once) ──────────────────────────────────
type AirspaceFeature = {
  name:     string
  cls:      string
  type:     string
  lower:    string
  upper:    string
  lower_ft: number
  upper_ft: number
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useAirspaceWarnings(
  position: GpsPosition | null,
  lookaheadMin: number = DEFAULT_LOOKAHEAD_MIN,
  verticalFt: number = 500,
): {
  alerts:  AirspaceAlert[]
  dismiss: (key: string) => void
} {
  const [features, setFeatures] = useState<AirspaceFeature[]>([])
  const [alerts,   setAlerts]   = useState<AirspaceAlert[]>([])

  // Map from key → timestamp when dismissed; cleaned up lazily.
  const dismissedRef = useRef<Map<string, number>>(new Map())

  // Previous altitude sample — used to derive climb/descent rate.
  const prevAltRef = useRef<{ altFt: number; ts: number } | null>(null)

  // Last-committed result signature -- skip setAlerts() when the computed
  // set is identical to what's already in state. This hook (not to be
  // confused with the similarly-named useAirspaceNotifications.ts) drives
  // the "CLASS C ... AHEAD"-style banner directly, and was missed in the
  // 2026-09-13 change-detection pass applied to useAirfieldProximity/
  // useObstructionWarnings/useAirspaceNotifications -- it was firing a
  // fresh setAlerts(found) array every single position tick right at the
  // exact airspace-transition moment that reproduced "Maximum update depth
  // exceeded" during Simulate mode. Mirrors native's identical fix.
  const lastSigRef = useRef<string>('')

  // ── Load airspace GeoJSON once ────────────────────────────────────────────
  useEffect(() => {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson'))
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const arr: AirspaceFeature[] = []
        for (const f of fc.features) {
          const g = f.geometry
          if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
          const p = f.properties as Record<string, unknown>
          const cls      = String(p['class'] ?? '')
          const type     = String(p['type']  ?? '')
          const name     = String(p['name']  ?? '')
          const lower    = String(p['lower'] ?? '')
          const upper    = String(p['upper'] ?? '')
          const lower_ft = Number(p['lower_ft'] ?? 0)
          const upper_ft = Number(p['upper_ft'] ?? 99900)
          // Skip unclassified / class-G open FIR (no practical restriction)
          if (!cls && !type) continue
          arr.push({ name, cls, type, lower, upper, lower_ft, upper_ft, geometry: g })
        }
        setFeatures(arr)
      })
      .catch(() => { /* silently ignore offline */ })
  }, [])

  // ── Evaluate alerts on each position change ───────────────────────────────
  useEffect(() => {
    if (!position || features.length === 0) {
      if (lastSigRef.current !== '') {
        lastSigRef.current = ''
        setAlerts([])
      }
      return
    }

    const { lat, lng, altFt, speedKts, trackDeg } = position
    const now = Date.now()

    // ── Derive climb rate from previous position tick ─────────────────────
    const prev = prevAltRef.current
    const climbRateFpm = (prev && (now - prev.ts) > 1000)
      ? (altFt - prev.altFt) / ((now - prev.ts) / 60_000)
      : 0
    prevAltRef.current = { altFt, ts: now }

    // Minimum meaningful climb/descent rate — below this treat as level.
    const VERT_THRESHOLD_FPM = 100

    // Lookahead path — sample LOOKAHEAD_SAMPLES evenly-spaced points from
    // (1/N × lookDist) to (lookDist) along the current track.  Checking only
    // the endpoint misses narrow or small airspaces that the aircraft would
    // cross entirely within the lookahead window.
    const speedForLook = Math.max(speedKts, LOOKAHEAD_MIN_SPEED)
    const lookDistNm   = (lookaheadMin / 60) * speedForLook
    const aheadSamples = Array.from({ length: LOOKAHEAD_SAMPLES }, (_, i) =>
      advancePosition(lat, lng, trackDeg, lookDistNm * ((i + 1) / LOOKAHEAD_SAMPLES)),
    )

    const found: AirspaceAlert[] = []

    for (const f of features) {
      const altInBand = altFt >= f.lower_ft && altFt <= f.upper_ft

      // ── Case 1: altitude inside band — check for horizontal penetration ──
      if (altInBand) {
        const key = `${f.name}::${f.cls}`
        const dismissedAt = dismissedRef.current.get(key)
        if (dismissedAt === undefined || now - dismissedAt >= DISMISS_REARM_MS) {
          const insideCurrent = pointInPolygon(lat, lng, f.geometry)
          const insideAhead   = !insideCurrent &&
            aheadSamples.some(p => pointInPolygon(p.lat, p.lng, f.geometry))

          if (insideCurrent || insideAhead) {
            found.push({
              key,
              name:     f.name,
              cls:      f.cls,
              type:     f.type,
              lower:    f.lower,
              upper:    f.upper,
              lower_ft: f.lower_ft,
              upper_ft: f.upper_ft,
              severity: getSeverity(f.cls),
              inside:   insideCurrent,
            })
          }
        }
        continue
      }

      // ── Case 2: altitude outside band — check for vertical closure ───────
      // Only warn if the aircraft is horizontally inside or approaching the polygon.
      const horizMatch =
        pointInPolygon(lat, lng, f.geometry) ||
        aheadSamples.some(p => pointInPolygon(p.lat, p.lng, f.geometry))
      if (!horizMatch) continue

      // Approaching floor from below (climbing) — time-based projection OR
      // within static verticalFt buffer of the floor.
      if (
        altFt < f.lower_ft &&
        (
          (climbRateFpm > VERT_THRESHOLD_FPM && altFt + climbRateFpm * lookaheadMin >= f.lower_ft) ||
          (verticalFt > 0 && (f.lower_ft - altFt) <= verticalFt)
        )
      ) {
        const vKey = `${f.name}::${f.cls}::floor`
        const dismissedAt = dismissedRef.current.get(vKey)
        if (dismissedAt === undefined || now - dismissedAt >= DISMISS_REARM_MS) {
          found.push({
            key:            vKey,
            name:           f.name,
            cls:            f.cls,
            type:           f.type,
            lower:          f.lower,
            upper:          f.upper,
            lower_ft:       f.lower_ft,
            upper_ft:       f.upper_ft,
            severity:       getSeverity(f.cls),
            inside:         false,
            verticalClosure: 'floor',
            gapFt:          Math.round(f.lower_ft - altFt),
          })
        }
      }

      // Approaching ceiling from above (descending) — time-based projection OR
      // within static verticalFt buffer of the ceiling.
      if (
        altFt > f.upper_ft &&
        (
          (climbRateFpm < -VERT_THRESHOLD_FPM && altFt + climbRateFpm * lookaheadMin <= f.upper_ft) ||
          (verticalFt > 0 && (altFt - f.upper_ft) <= verticalFt)
        )
      ) {
        const vKey = `${f.name}::${f.cls}::ceiling`
        const dismissedAt = dismissedRef.current.get(vKey)
        if (dismissedAt === undefined || now - dismissedAt >= DISMISS_REARM_MS) {
          found.push({
            key:            vKey,
            name:           f.name,
            cls:            f.cls,
            type:           f.type,
            lower:          f.lower,
            upper:          f.upper,
            lower_ft:       f.lower_ft,
            upper_ft:       f.upper_ft,
            severity:       getSeverity(f.cls),
            inside:         false,
            verticalClosure: 'ceiling',
            gapFt:          Math.round(altFt - f.upper_ft),
          })
        }
      }
    }

    // Sort: inside-now first, then vertical-closure, then by severity, then by lower_ft
    found.sort((a, b) => {
      if (a.inside !== b.inside) return a.inside ? -1 : 1
      const sd = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      if (sd !== 0) return sd
      return a.lower_ft - b.lower_ft
    })

    const sig = found.map(a => `${a.key}:${a.inside}:${a.verticalClosure ?? ''}:${a.gapFt ?? ''}`).join('|')
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig
      setAlerts(found)
    }
  }, [position, features, lookaheadMin, verticalFt])

  const dismiss = useCallback((key: string) => {
    dismissedRef.current.set(key, Date.now())
    setAlerts(prev => prev.filter(a => a.key !== key))
  }, [])

  return { alerts, dismiss }
}
