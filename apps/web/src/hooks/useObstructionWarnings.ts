/**
 * useObstructionWarnings — proximity alerts for fixed obstacles.
 *
 * Loads the obstacles and landmarks files once on mount (unknown heights use
 * the per-kind estimate, see @open-vfr/shared/obstructionPoints). On each position update,
 * scans all obstacles within a configurable horizontal radius and checks
 * whether the aircraft altitude is within a vertical clearance margin.
 *
 * An alert fires when:
 *   - Horizontal distance ≤ WARN_RADIUS_NM (default 1 NM), AND
 *   - Aircraft altitude ≤ obstacle tip elevation + VERTICAL_BUFFER_FT (default 500 ft)
 *
 * Returns up to MAX_ALERTS sorted by distance (closest first).
 * Dismiss suppresses that obstacle for DISMISS_REARM_MS (5 min).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { useActiveCountries } from '../utils/countryData'
import { buildObstructionPoints, obstructionTipFt, groupObstructionAlerts, obstructionAlertsSig, type ObstructionPoint } from '@open-vfr/shared/obstructionPoints'
import { useMefGrids } from './useMefGrids'

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
  /** Tip height is the per-kind estimate, not a recorded value. */
  estimated:   boolean
  distNm:      number
  /** Obstacles of this kind in range (alerts are grouped per kind). */
  count:       number
}

type ObstaclePoint = ObstructionPoint

// ── Fast approximate distance ─────────────────────────────────────────────────
function approxDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT
  const cosLat = Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  const dLng = (lng2 - lng1) * NM_PER_DEG_LAT * cosLat
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useObstructionWarnings(position: (GpsPosition & { terrainFt?: number | null }) | null): {
  alerts:  ObstructionAlert[]
  dismiss: (key: string) => void
} {
  const [obstacleFc, setObstacleFc] = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkFc, setLandmarkFc] = useState<GeoJSON.FeatureCollection | null>(null)
  const mefGrids = useMefGrids()
  const obstacles = useMemo<ObstaclePoint[]>(() => buildObstructionPoints(obstacleFc, landmarkFc, mefGrids), [obstacleFc, landmarkFc, mefGrids])
  const [alerts,    setAlerts]    = useState<ObstructionAlert[]>([])
  const dismissedRef = useRef<Map<string, number>>(new Map())
  // Last-committed result signature -- skip setAlerts() when the computed
  // set is unchanged. See useAirfieldProximity.ts's identical fix for the
  // full rationale (2026-09-13, "Maximum update depth exceeded" mitigation).
  const lastSigRef = useRef<string>('')

  // ── Load once ───────────────────────────────────────────────────────────────
  const { key: countriesKey } = useActiveCountries()
  useEffect(() => {
    loadCountryGeojson('obstacles').then(setObstacleFc).catch(() => { /* silently ignore offline */ })
    loadCountryGeojson('landmarks').then(setLandmarkFc).catch(() => { /* optional dataset */ })
  }, [countriesKey])

  // ── Evaluate on every position update ───────────────────────────────────────
  useEffect(() => {
    if (!position || obstacles.length === 0) {
      if (lastSigRef.current !== '') {
        lastSigRef.current = ''
        setAlerts([])
      }
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
      const tipFt = obstructionTipFt(obs, position.terrainFt)
      if (tipFt == null || altFt > tipFt + VERTICAL_BUFFER_FT) continue

      found.push({
        key:         obs.key,
        kind:        obs.kind,
        name:        obs.name || obs.kind.replace('_', ' '),
        elevationFt: obs.groundKnown ? obs.elevFt : Math.round(position.terrainFt ?? 0),
        tipFt,
        estimated:   obs.estimated,
        distNm,
        count:       1,
      })

    }

    // One alert per kind; dismissing silences the kind for a while.
    const grouped = groupObstructionAlerts(found)
      .filter(g => { const d = dismissedRef.current.get(g.key); return d === undefined || now - d >= DISMISS_REARM_MS })
      .slice(0, MAX_ALERTS)
    const sig = obstructionAlertsSig(grouped)
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig
      setAlerts(grouped)
    }
  }, [position, obstacles])

  const dismiss = useCallback((key: string) => {
    dismissedRef.current.set(key, Date.now())
    setAlerts(prev => prev.filter(a => a.key !== key))
  }, [])

  return { alerts, dismiss }
}
