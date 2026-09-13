/**
 * useAirspaceNotifications (native) — silent entry/exit notifications for airspace.
 *
 * Identical logic to the web hook (src/hooks/useAirspaceNotifications.ts).
 * Differences:
 *   - Fetches from getTileUrls().airspace (absolute URL via adb reverse or prod)
 *   - Uses @open-vfr/shared/airspaceGeometry's pointInPolygon (same one
 *     useAirspaceWarnings already uses) instead of a local duplicate
 *
 * Separate from useAirspaceWarnings (proactive penetration alerts).
 * Tracks transitions: when the aircraft enters or leaves an airspace polygon
 * it fires a short-lived toast notification. No lookahead — current position only.
 *
 * Notifications auto-expire after NOTIFICATION_TTL_MS. The hook itself prunes
 * expired entries every second so the component re-renders naturally.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { pointInPolygon } from '@open-vfr/shared/airspaceGeometry'
import { getTileUrls } from '../config'

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
  if (cls === 'R' || cls === 'TRA') return 'red'
  if (cls === 'C' || cls === 'D')   return 'yellow'
  return 'blue'
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
  geometry: { type: 'Polygon'; coordinates: number[][][] }
           | { type: 'MultiPolygon'; coordinates: number[][][][] }
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useAirspaceNotifications(position: GpsPosition | null): {
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
    fetch(getTileUrls().airspace)
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const arr: AirspaceFeature[] = []
        for (const f of fc.features) {
          const g = f.geometry
          if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
          const p        = f.properties as Record<string, unknown>
          const cls      = String(p['class'] ?? '')
          const type     = String(p['type']  ?? '')
          const name     = String(p['name']  ?? '')
          const lower    = String(p['lower'] ?? '')
          const upper    = String(p['upper'] ?? '')
          const lower_ft = Number(p['lower_ft'] ?? 0)
          const upper_ft = Number(p['upper_ft'] ?? 99900)
          if (!cls && !type) continue
          arr.push({
            key: `${name}::${cls}`,
            name, cls, type, lower, upper, lower_ft, upper_ft,
            geometry: g as AirspaceFeature['geometry'],
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
      setNotifications(prev => prev.filter(n => n.expiresAt > now))
    }, 1_000)
    return () => clearInterval(timer)
  }, [])

  // ── Detect entry/exit transitions on each position tick ───────────────────
  useEffect(() => {
    if (!position || features.length === 0) return

    const { lat, lng, altFt } = position
    const now = Date.now()

    // Build current inside-set (vertically filtered)
    const current = new Set<string>()
    for (const f of features) {
      if (altFt < f.lower_ft || altFt > f.upper_ft) continue
      if (pointInPolygon(lat, lng, f.geometry)) current.add(f.key)
    }

    const prev = insideRef.current

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
        const freshKeys = new Set(fresh.map(n => n.name + '::' + n.cls))
        const kept = prev.filter(n => !freshKeys.has(n.name + '::' + n.cls))
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
