/**
 * useAirspaceNotifications — silent entry/exit notifications for airspace.
 *
 * Separate from useAirspaceWarnings (proactive penetration alerts).
 * Tracks transitions: when the aircraft enters or leaves an airspace polygon
 * it fires a short-lived toast notification. No lookahead — current position only.
 *
 * Notifications auto-expire after NOTIFICATION_TTL_MS. The hook itself prunes
 * expired entries every second so the component re-renders naturally.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { AlertPosition } from './useAirspaceWarnings'
import { TILES_BASE_URL } from '../utils/env'
import { altitudeForLimit, effectiveLimitFt, insideBand } from '@open-vfr/shared/airspaceAltitude'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import { airspaceDisplayClass } from '@open-vfr/shared/airspaceColors'

// ── Config ────────────────────────────────────────────────────────────────────
const NOTIFICATION_TTL_MS = 9_000   // visible for 9 s then fades
const MAX_QUEUE           = 8       // cap simultaneous notifications

// ── Types ─────────────────────────────────────────────────────────────────────
export type NotificationSeverity  = 'red' | 'yellow' | 'blue'
export type NotificationDirection = 'entered' | 'left'

export type AirspaceNotification = {
  /** Unique ID (name::cls::timestamp::direction) for React key. */
  id:        string
  name:      string
  cls:       string
  type:      string
  lower:     string
  upper:     string
  direction: NotificationDirection
  severity:  NotificationSeverity
  expiresAt: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSeverity(cls: string): NotificationSeverity {
  // Follows the usual chart-warning convention: prohibited/restricted/danger and
  // class A red; class B, C, D yellow. E/F are advisory and stay informational (blue).
  if (cls === 'R' || cls === 'TRA' || cls === 'A') return 'red'
  if (cls === 'B' || cls === 'C' || cls === 'D')   return 'yellow'
  return 'blue'
}

function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function pointInPolygon(
  lat: number,
  lng: number,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean {
  if (geometry.type === 'Polygon') {
    const [outer, ...holes] = geometry.coordinates
    if (!pointInRing(lat, lng, outer)) return false
    return !holes.some(h => pointInRing(lat, lng, h))
  }
  for (const poly of geometry.coordinates) {
    const [outer, ...holes] = poly
    if (!pointInRing(lat, lng, outer)) continue
    if (!holes.some(h => pointInRing(lat, lng, h))) return true
  }
  return false
}

// ── Internal feature record ────────────────────────────────────────────────
type AirspaceFeature = {
  key:      string
  name:     string
  cls:      string
  type:     string
  lower:    string
  upper:    string
  lower_ft: number
  upper_ft: number
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useAirspaceNotifications(position: AlertPosition | null): {
  notifications: AirspaceNotification[]
  clearAll:      () => void
} {
  const [features,      setFeatures]      = useState<AirspaceFeature[]>([])
  const [notifications, setNotifications] = useState<AirspaceNotification[]>([])

  /** Keys of airspace polygons the aircraft was inside on the previous tick. */
  const insideRef = useRef<Set<string>>(new Set())
  /** Whether the hook has run at least one position evaluation (prevents false "entered" on first tick). */
  const initializedRef = useRef(false)

  // ── Load airspace GeoJSON once ────────────────────────────────────────────
  useEffect(() => {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson'))
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const arr: AirspaceFeature[] = []
        for (const f of fc.features) {
          const g = f.geometry
          if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
          const p        = f.properties as Record<string, unknown>
          const type     = String(p['type']  ?? '')
          const cls      = airspaceDisplayClass(String(p['class'] ?? ''), type)
          const name     = String(p['name']  ?? '')
          const lower    = String(p['lower'] ?? '')
          const upper    = String(p['upper'] ?? '')
          const lower_ft = Number(p['lower_ft'] ?? 0)
          const upper_ft = Number(p['upper_ft'] ?? 99900)
          if (!cls && !type) continue
          arr.push({
            // Limits in the key: same-named sectors (CTR + TMA) are distinct airspaces.
            key: `${name}::${cls}::${lower_ft}-${upper_ft}`,
            name, cls, type, lower, upper, lower_ft, upper_ft,
            geometry: g,
          })
        }
        setFeatures(arr)
      })
      .catch(() => { /* offline-safe */ })
  }, [])

  // ── Prune expired notifications every second ──────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      // .filter() always returns a new array reference even when nothing
      // was actually removed -- skip the setState entirely in that case.
      // Mirrors native's identical fix (2026-09-13, "Maximum update depth
      // exceeded" mitigation).
      setNotifications(prev => {
        const next = prev.filter(n => n.expiresAt > now)
        return next.length === prev.length ? prev : next
      })
    }, 1_000)
    return () => clearInterval(timer)
  }, [])

  // ── Detect entry/exit transitions on each position tick ───────────────────
  useEffect(() => {
    if (!position || features.length === 0) return

    const { lat, lng, altFt } = position
    const now = Date.now()
    const ownAlt = { qnhFt: altFt, stdFt: position.altStdFt ?? null }
    const terrainFt = position.terrainFt ?? null
    const prev = insideRef.current

    // Build current inside-set (vertically filtered, per-limit reference, AGL
    // limits lifted by terrain, 100 ft hysteresis so a level flight at a
    // floor/ceiling does not flap entered/left).
    const current = new Set<string>()
    for (const f of features) {
      const lo = effectiveLimitFt(f.lower, f.lower_ft, terrainFt), hi = effectiveLimitFt(f.upper, f.upper_ft, terrainFt)
      if (!insideBand(altitudeForLimit(f.lower, ownAlt), altitudeForLimit(f.upper, ownAlt), lo, hi, prev.has(f.key))) continue
      if (pointInPolygon(lat, lng, f.geometry)) current.add(f.key)
    }

    // On the very first evaluation, just seed insideRef — don't fire notifications.
    if (!initializedRef.current) {
      insideRef.current    = current
      initializedRef.current = true
      return
    }

    const fresh: AirspaceNotification[] = []

    // Entered: in current but not in prev
    for (const key of current) {
      if (!prev.has(key)) {
        const f = features.find(x => x.key === key)
        if (!f) continue
        fresh.push({
          id:        `${key}::${now}::entered`,
          name:      f.name,
          cls:       f.cls,
          type:      f.type,
          lower:     f.lower,
          upper:     f.upper,
          direction: 'entered',
          severity:  getSeverity(f.cls),
          expiresAt: now + NOTIFICATION_TTL_MS,
        })
      }
    }

    // Left: in prev but not in current
    for (const key of prev) {
      if (!current.has(key)) {
        const f = features.find(x => x.key === key)
        if (!f) continue
        fresh.push({
          id:        `${key}::${now}::left`,
          name:      f.name,
          cls:       f.cls,
          type:      f.type,
          lower:     f.lower,
          upper:     f.upper,
          direction: 'left',
          severity:  getSeverity(f.cls),
          expiresAt: now + NOTIFICATION_TTL_MS,
        })
      }
    }

    insideRef.current = current

    if (fresh.length > 0) {
      setNotifications(prev => {
        // Dedup by airspace key: update-in-place (new direction/expiry) rather than
        // stacking a second banner for the same airspace (e.g. boundary jitter).
        const idOf = (n: AirspaceNotification) => `${n.name}::${n.cls}::${n.lower}-${n.upper}`
        const freshKeys = new Set(fresh.map(idOf))
        const kept = prev.filter(n => !freshKeys.has(idOf(n)))
        return [...fresh, ...kept].slice(0, MAX_QUEUE)
      })
    }
  }, [position, features])

  // Reset when position goes null (flying mode off)
  useEffect(() => {
    if (!position) {
      insideRef.current    = new Set()
      initializedRef.current = false
      setNotifications([])
    }
  }, [position])

  const clearAll = useCallback(() => setNotifications([]), [])

  return { notifications, clearAll }
}
