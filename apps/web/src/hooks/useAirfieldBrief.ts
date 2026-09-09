/**
 * useAirfieldBrief — returns the "active" aerodrome for the Airfield Brief panel.
 *
 * Priority:
 *  1. The active route waypoint (activeWpIdx) if it is within 8 NM and there is
 *     an aerodrome at that waypoint location (matched by 0.5 NM proximity).
 *  2. The nearest unplanned aerodrome within BRIEF_DIST_NM (3 NM).
 *
 * Returns null when no aerodrome qualifies or when flyingMode is 'off'.
 */

import { useState, useEffect, useRef } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { AerodromeFeatureProps } from '../components/AerodromePopup'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// ── Constants ─────────────────────────────────────────────────────────────────
const BRIEF_DIST_NM  = 3     // nearest-aerodrome trigger radius
const DEST_DIST_NM   = 8     // route-destination trigger radius
const ROUTE_MATCH_NM = 0.5   // aerodrome is "the destination" if within this of active WP

// ── Types ─────────────────────────────────────────────────────────────────────
export interface BriefAerodrome {
  icao:    string
  name:    string
  lat:     number
  lng:     number
  distNm:  number
  /** Full props ready for AerodromePopup — allows tapping to open full info. */
  props:   AerodromeFeatureProps
}

// Internal full-data aerodrome record (superset of BriefAerodrome)
interface FullAerodrome {
  key:     string
  lat:     number
  lng:     number
  props:   AerodromeFeatureProps
}

// Module-level cache so multiple hook instances share one fetch
let cachedAerodromes: FullAerodrome[] | null = null
let loadPromise: Promise<FullAerodrome[]> | null = null

function loadAerodromes(): Promise<FullAerodrome[]> {
  if (cachedAerodromes) return Promise.resolve(cachedAerodromes)
  if (loadPromise) return loadPromise
  loadPromise = fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      const arr: FullAerodrome[] = []
      for (const f of fc.features) {
        if (f.geometry.type !== 'Point') continue
        const p   = f.properties as Record<string, unknown>
        const icao = String(p['icao'] ?? '')
        const name = String(p['name'] ?? '')
        if (!icao && !name) continue
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates

        const parseJsonArr = <T,>(v: unknown): T[] => {
          if (Array.isArray(v)) return v as T[]
          if (typeof v === 'string') { try { return JSON.parse(v) as T[] } catch { return [] } }
          return []
        }

        const props: AerodromeFeatureProps = {
          icao,
          name,
          type:         String(p['type'] ?? 'AD'),
          elevation_ft: p['elevation_ft'] != null ? Number(p['elevation_ft']) : null,
          frequencies:  parseJsonArr(p['frequencies']),
          fuel:         parseJsonArr(p['fuel']),
          ppr:          Boolean(p['ppr']),
          ppr_remarks:  parseJsonArr(p['ppr_remarks']),
          contacts:     parseJsonArr(p['contacts']),
          runways:      parseJsonArr(p['runways']),
        }
        arr.push({ key: icao || name, lat, lng, props })
      }
      cachedAerodromes = arr
      return arr
    })
    .catch(() => { loadPromise = null; return [] })
  return loadPromise
}

function approxDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos(lat1 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useAirfieldBrief(
  position:       GpsPosition | null,
  routeWaypoints: RouteWaypoint[],
  activeWpIdx:    number,
): BriefAerodrome | null {
  const [aerodromes, setAerodromes] = useState<FullAerodrome[]>([])
  const [brief, setBrief]           = useState<BriefAerodrome | null>(null)
  const prevKeyRef                  = useRef<string | null>(null)

  // Load aerodrome data once
  useEffect(() => {
    loadAerodromes().then(arr => {
      if (arr.length > 0) setAerodromes(arr)
    })
  }, [])

  useEffect(() => {
    if (!position || aerodromes.length === 0) {
      setBrief(null)
      prevKeyRef.current = null
      return
    }

    const { lat, lng } = position

    // 1. Check if active route waypoint is an aerodrome within DEST_DIST_NM
    const activeWp = routeWaypoints[activeWpIdx]
    let destAerodrome: FullAerodrome | null = null
    if (activeWp) {
      const destDist = approxDistNm(lat, lng, activeWp.lat, activeWp.lng)
      if (destDist <= DEST_DIST_NM) {
        // Find the aerodrome at the waypoint location
        let best: FullAerodrome | null = null
        let bestDist = ROUTE_MATCH_NM
        for (const ad of aerodromes) {
          const d = approxDistNm(activeWp.lat, activeWp.lng, ad.lat, ad.lng)
          if (d <= bestDist) { bestDist = d; best = ad }
        }
        if (best) destAerodrome = best
      }
    }

    // 2. Nearest aerodrome within BRIEF_DIST_NM (any aerodrome)
    let nearest: FullAerodrome | null = null
    let nearestDist = BRIEF_DIST_NM
    for (const ad of aerodromes) {
      const d = approxDistNm(lat, lng, ad.lat, ad.lng)
      if (d <= nearestDist) { nearestDist = d; nearest = ad }
    }

    // Priority: destination > nearest
    const chosen = destAerodrome ?? nearest
    if (!chosen) {
      setBrief(null)
      prevKeyRef.current = null
      return
    }

    const dist = approxDistNm(lat, lng, chosen.lat, chosen.lng)
    const key  = chosen.key
    // Only update state when the key changes (avoids re-renders on every GPS tick)
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key
      setBrief({ icao: chosen.props.icao, name: chosen.props.name, lat: chosen.lat, lng: chosen.lng, distNm: dist, props: chosen.props })
    } else {
      // Update distance only (no key change → same aerodrome)
      setBrief(prev => prev ? { ...prev, distNm: dist } : prev)
    }
  }, [position, aerodromes, routeWaypoints, activeWpIdx])

  return brief
}
