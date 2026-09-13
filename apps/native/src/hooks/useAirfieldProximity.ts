/**
 * useAirfieldProximity (native) — warn when approaching an unplanned aerodrome.
 *
 * Identical logic to the web hook (src/hooks/useAirfieldProximity.ts).
 * Only difference: fetches from getTileUrls().aerodromes instead of the
 * relative web path. RouteWaypoint shape (`lat`/`lng`/`name`/`note`) is
 * shared via @open-vfr/shared/types — no field mapping needed.
 *
 * Fires when the aircraft is within:
 *   - LATERAL_NM  (1.0 NM) horizontally
 *   - VERTICAL_FT (1,500 ft) vertically of an aerodrome's elevation
 *
 * Aerodromes that appear in routeWaypoints (matched by proximity ≤ 0.5 NM)
 * are excluded — they are planned destinations and need no proximity alert.
 *
 * Alerts are dismissed manually or auto-cleared when outside the threshold.
 * Dismissed alerts re-arm after REARM_MS if the aircraft is still close.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { RouteWaypoint } from '@open-vfr/shared/types'
import { getTileUrls } from '../config'

// ── Config ────────────────────────────────────────────────────────────────────
const LATERAL_NM   = 1.0
const VERTICAL_FT  = 1_500
const REARM_MS     = 5 * 60_000   // 5 minutes before re-alerting a dismissed aerodrome
const DEG_PER_NM   = 1 / 60      // approximate for bounding-box pre-filter
const ROUTE_MATCH_NM = 0.5       // aerodrome is "on route" if a waypoint is this close

// ── Types ─────────────────────────────────────────────────────────────────────
export type AirfieldProximityAlert = {
  key:         string   // icao (or name if no icao)
  icao:        string
  name:        string
  distNm:      number
  elevationFt: number
  /** Primary ATC frequency (MHz formatted e.g. "118.100") or null. */
  primaryFreq: string | null
}

// ── Internal aerodrome record ─────────────────────────────────────────────────
type AerodromeFeature = {
  key:         string
  icao:        string
  name:        string
  lat:         number
  lng:         number
  elevationFt: number
  primaryFreq: string | null
}

// ── Geometry helpers ──────────────────────────────────────────────────────────
function approxDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos(lat1 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useAirfieldProximity(
  position:       GpsPosition | null,
  routeWaypoints: RouteWaypoint[],
): {
  alerts:  AirfieldProximityAlert[]
  dismiss: (key: string) => void
} {
  const [aerodromes, setAerodromes] = useState<AerodromeFeature[]>([])
  const [alerts,     setAlerts]     = useState<AirfieldProximityAlert[]>([])

  const dismissedRef = useRef<Map<string, number>>(new Map())
  // Last-committed result signature -- skip setAlerts() when the computed
  // set is identical to what's already in state. Without this, every
  // position tick (5 Hz while flying/simulating) called setAlerts(found)
  // unconditionally with a brand-new array/object literal even when nothing
  // actually changed, forcing NotificationCenter (and everything upstream of
  // it) to re-render 5x/sec regardless -- unnecessary render pressure that
  // contributed to the "Maximum update depth exceeded" warning observed
  // during Simulate mode right at an airspace-transition moment (2026-09-13),
  // when this churn coincided with other hooks' own genuine state changes.
  const lastSigRef = useRef<string>('')

  // ── Load aerodromes GeoJSON once ──────────────────────────────────────────
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
          // Pick primary frequency
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
          // Fallback: contacts[type=RADIO]
          if (!primaryFreq) {
            const rc = contacts.find(c => c.type === 'RADIO' && c.address)
            if (rc) { const mhz = parseFloat(rc.address!); if (!isNaN(mhz)) primaryFreq = mhz.toFixed(3) }
          }
          arr.push({ key, icao, name, lat, lng, elevationFt: elevFt, primaryFreq })
        }
        setAerodromes(arr)
      })
      .catch(() => { /* offline-safe */ })
  }, [])

  // ── Evaluate on each position + route change ───────────────────────────────
  useEffect(() => {
    if (!position || aerodromes.length === 0) {
      if (lastSigRef.current !== '') {
        lastSigRef.current = ''
        setAlerts([])
      }
      return
    }

    const { lat, lng, altFt } = position
    const now = Date.now()

    // Build set of "on-route" aerodromes by proximity to any route waypoint
    const routeOnAero = new Set<string>()
    for (const ad of aerodromes) {
      for (const wp of routeWaypoints) {
        if (approxDistNm(ad.lat, ad.lng, wp.lat, wp.lng) <= ROUTE_MATCH_NM) {
          routeOnAero.add(ad.key)
          break
        }
      }
    }

    const found: AirfieldProximityAlert[] = []

    for (const ad of aerodromes) {
      // Skip planned aerodromes
      if (routeOnAero.has(ad.key)) continue

      // Bounding-box pre-filter
      if (Math.abs(lat - ad.lat) > LATERAL_NM * DEG_PER_NM * 1.5) continue
      if (Math.abs(lng - ad.lng) > LATERAL_NM * DEG_PER_NM * 2.5) continue

      const distNm = approxDistNm(lat, lng, ad.lat, ad.lng)
      if (distNm > LATERAL_NM) continue

      // Vertical check: within VERTICAL_FT of aerodrome elevation
      if (Math.abs(altFt - ad.elevationFt) > VERTICAL_FT) continue

      // Dismiss cooldown
      const dismissedAt = dismissedRef.current.get(ad.key)
      if (dismissedAt !== undefined && now - dismissedAt < REARM_MS) continue

      found.push({
        key:         ad.key,
        icao:        ad.icao,
        name:        ad.name,
        distNm:      Math.round(distNm * 10) / 10,
        elevationFt: ad.elevationFt,
        primaryFreq: ad.primaryFreq,
      })
    }

    // Sort by distance
    found.sort((a, b) => a.distNm - b.distNm)

    const sig = found.map(a => `${a.key}:${a.distNm}`).join('|')
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig
      setAlerts(found)
    }
  }, [position, aerodromes, routeWaypoints])

  const dismiss = useCallback((key: string) => {
    dismissedRef.current.set(key, Date.now())
    setAlerts(prev => prev.filter(a => a.key !== key))
  }, [])

  return { alerts, dismiss }
}
