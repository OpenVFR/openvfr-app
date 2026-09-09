/**
 * useObstructionWarnings (native) — proximity alerts for fixed obstacles.
 *
 * Identical logic to the web hook (src/hooks/useObstructionWarnings.ts).
 * Only difference: fetches from TILE_URLS.obstacles (absolute URL via
 * adb reverse or prod) instead of the relative web path.
 *
 * An alert fires when:
 *   - Horizontal distance ≤ WARN_RADIUS_NM (default 1 NM), AND
 *   - Aircraft altitude ≤ obstacle tip elevation + VERTICAL_BUFFER_FT (default 500 ft)
 *
 * Returns up to MAX_ALERTS sorted by distance (closest first).
 * Dismiss suppresses that obstacle for DISMISS_REARM_MS (5 min).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { TILE_URLS } from '../config'

// ── Config ───────────────────────────────────────────────────────────────────
const WARN_RADIUS_NM      = 1.0    // horizontal warning radius
const VERTICAL_BUFFER_FT  = 500    // fire if aircraft ≤ tip + 500 ft
const MAX_ALERTS          = 5
const DISMISS_REARM_MS    = 5 * 60_000
const NM_PER_DEG_LAT      = 60.0

// ── Types ────────────────────────────────────────────────────────────────────
export type ObstructionAlert = {
  key:         string   // stable id (name or index)
  kind:        string   // obstacle kind
  name:        string
  elevationFt: number  // ground AMSL ft
  tipFt:       number  // tip altitude AMSL ft
  distNm:      number
}

type ObstaclePoint = {
  key:        string
  lat:        number
  lng:        number
  kind:       string
  name:       string
  elevFt:     number
  tipFt:      number
}

// ── Fast approximate distance ─────────────────────────────────────────────────
function approxDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT
  const cosLat = Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  const dLng = (lng2 - lng1) * NM_PER_DEG_LAT * cosLat
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useObstructionWarnings(position: GpsPosition | null): {
  alerts:  ObstructionAlert[]
  dismiss: (key: string) => void
} {
  const [obstacles, setObstacles] = useState<ObstaclePoint[]>([])
  const [alerts,    setAlerts]    = useState<ObstructionAlert[]>([])
  const dismissedRef = useRef<Map<string, number>>(new Map())

  // ── Load once ───────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(TILE_URLS.obstacles)
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
          const key     = name || `obs-${i}`
          pts.push({ key, lat: g.coordinates[1], lng: g.coordinates[0], kind, name, elevFt, tipFt })
        })
        setObstacles(pts)
      })
      .catch(() => { /* silently ignore offline */ })
  }, [])

  // ── Evaluate on every position update ───────────────────────────────────────
  useEffect(() => {
    if (!position || obstacles.length === 0) {
      setAlerts([])
      return
    }

    const { lat, lng, altFt } = position
    const now = Date.now()
    const found: ObstructionAlert[] = []

    for (const obs of obstacles) {
      // Fast bounding-box pre-filter (1 NM ≈ 1/60 degrees lat)
      if (Math.abs(obs.lat - lat) > WARN_RADIUS_NM / NM_PER_DEG_LAT * 1.2) continue

      const distNm = approxDistNm(lat, lng, obs.lat, obs.lng)
      if (distNm > WARN_RADIUS_NM) continue

      // Vertical filter: only warn if aircraft is at risk altitude
      if (altFt > obs.tipFt + VERTICAL_BUFFER_FT) continue

      // Dismiss check
      const dismissedAt = dismissedRef.current.get(obs.key)
      if (dismissedAt !== undefined && now - dismissedAt < DISMISS_REARM_MS) continue

      found.push({
        key:         obs.key,
        kind:        obs.kind,
        name:        obs.name || obs.kind.replace('_', ' '),
        elevationFt: obs.elevFt,
        tipFt:       obs.tipFt,
        distNm,
      })

      if (found.length >= MAX_ALERTS) break
    }

    found.sort((a, b) => a.distNm - b.distNm)
    setAlerts(found)
  }, [position, obstacles])

  const dismiss = useCallback((key: string) => {
    dismissedRef.current.set(key, Date.now())
    setAlerts(prev => prev.filter(a => a.key !== key))
  }, [])

  return { alerts, dismiss }
}
