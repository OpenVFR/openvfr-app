/**
 * useNearestFeature — finds the nearest named aviation feature to the aircraft.
 *
 * Loads se-aerodromes, se-navaids, se-waypoints GeoJSON once on mount.
 * On each position update, scans all ~600 points and returns the closest one
 * within 50 NM. Aerodromes take priority over navaids > waypoints in tie-breaks.
 *
 * Used by GoFlyingPanel to display the persistent position-report banner.
 */

import { useState, useEffect } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { distanceNm, bearingDeg } from '../utils/routeCalc'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

export type NearestFeature = {
  name:        string
  kind:        'aerodrome' | 'navaid' | 'waypoint'
  distNm:      number
  bearingTrue: number  // 0–360, true bearing FROM aircraft TO feature
  /** Tower / controlled-aerodrome contact freq (TWR or AFIS). Aerodromes only. */
  primaryFreq:     string | null
  /** Enroute / FIS / Information service freq (FIS > INFO > AFIS > COM). */
  enrouteFreq:     string | null
  /** Nearest aerodrome with a TWR/AFIS freq (may differ from nearest overall feature). */
  nearestTwrFreq:      string | null
  /** Distance to that TWR aerodrome in NM. */
  nearestTwrDistNm:    number | null
  /** True when nearestTwrFreq came from a controlled (TWR/AFIS) aerodrome. */
  nearestTwrControlled: boolean
}

type Point = {
  lat:                  number
  lng:                  number
  name:                 string
  kind:                 NearestFeature['kind']
  priority:             number
  primaryFreq:          string | null
  /** True when primaryFreq came from frequencies[TWR|AFIS] (controlled aerodrome). */
  primaryFreqControlled: boolean
  enrouteFreq:          string | null
}

export type TrackedPoint = {
  lat:  number
  lng:  number
  name: string
  kind: NearestFeature['kind']
}

const MAX_DIST_NM = 50

export function useNearestFeature(
  position:     GpsPosition | null,
  trackedPoint: TrackedPoint | null = null,
): NearestFeature | null {
  const [points,  setPoints]  = useState<Point[]>([])
  const [nearest, setNearest] = useState<NearestFeature | null>(null)

  // ── Load GeoJSON files once ───────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson')).then(r => r.json()) as Promise<GeoJSON.FeatureCollection>,
      fetch(versionedTileUrl(TILES_BASE_URL, 'se-navaids.geojson')).then(r => r.json())    as Promise<GeoJSON.FeatureCollection>,
      fetch(versionedTileUrl(TILES_BASE_URL, 'se-waypoints.geojson')).then(r => r.json())  as Promise<GeoJSON.FeatureCollection>,
    ]).then(([ads, navs, wps]) => {
      const pts: Point[] = []

      for (const f of ads.features) {
        const g = f.geometry as GeoJSON.Point
        const p = f.properties as { icao?: string; name?: string; frequencies?: unknown; contacts?: unknown }
        const name = String(p.icao ?? p.name ?? '').trim()
        const freqs: Array<{ service?: string; freq_mhz?: number }> =
          Array.isArray(p.frequencies) ? p.frequencies
          : typeof p.frequencies === 'string' ? JSON.parse(p.frequencies)
          : []
        const contacts: Array<{ type?: string; address?: string }> =
          Array.isArray(p.contacts) ? p.contacts
          : typeof p.contacts === 'string' ? JSON.parse(p.contacts)
          : []
        const PRIMARY_ORDER   = ['TWR', 'AFIS']
        const ENROUTE_ORDER   = ['FIS', 'INFO', 'AFIS', 'COM', 'RDO', 'RADIO']
        let primaryFreq:  string | null = null
        let enrouteFreq:  string | null = null
        let primaryFreqControlled = false
        for (const svc of PRIMARY_ORDER) {
          const match = freqs.find(fq => fq.service === svc && fq.freq_mhz != null)
          if (match) { primaryFreq = match.freq_mhz!.toFixed(3); primaryFreqControlled = true; break }
        }
        for (const svc of ENROUTE_ORDER) {
          const match = freqs.find(fq => fq.service === svc && fq.freq_mhz != null)
          if (match) { enrouteFreq = match.freq_mhz!.toFixed(3); break }
        }
        // Fallback: if no tower freq, use first available from frequencies[]
        if (!primaryFreq && !enrouteFreq && freqs.length > 0 && freqs[0].freq_mhz != null) {
          primaryFreq = freqs[0].freq_mhz!.toFixed(3)
        }
        // Final fallback: contacts[type=RADIO] carries the aerodrome's self-announce freq
        if (!primaryFreq) {
          const radioContact = contacts.find(c => c.type === 'RADIO' && c.address)
          if (radioContact) {
            const mhz = parseFloat(radioContact.address!)
            if (!isNaN(mhz)) primaryFreq = mhz.toFixed(3)
            // primaryFreqControlled stays false — uncontrolled self-announce
          }
        }
        if (name) pts.push({ lat: g.coordinates[1], lng: g.coordinates[0], name, kind: 'aerodrome', priority: 0, primaryFreq, primaryFreqControlled, enrouteFreq })
      }

      for (const f of navs.features) {
        const g = f.geometry as GeoJSON.Point
        const p = f.properties as { id?: string; name?: string }
        const name = String(p.id ?? p.name ?? '').trim()
        if (name) pts.push({ lat: g.coordinates[1], lng: g.coordinates[0], name, kind: 'navaid', priority: 1, primaryFreq: null, primaryFreqControlled: false, enrouteFreq: null })
      }

      // Waypoints: MRP first (mandatory reporting points), then RP
      for (const f of wps.features) {
        const g = f.geometry as GeoJSON.Point
        const p = f.properties as { id?: string; name?: string; wp_type?: string }
        if (p.wp_type !== 'MRP' && p.wp_type !== 'RP') continue
        const name = String(p.id ?? p.name ?? '').trim()
        const pri  = p.wp_type === 'MRP' ? 2 : 3
        if (name) pts.push({ lat: g.coordinates[1], lng: g.coordinates[0], name, kind: 'waypoint', priority: pri, primaryFreq: null, primaryFreqControlled: false, enrouteFreq: null })
      }

      setPoints(pts)
    }).catch(console.error)
  }, [])

  // ── Find nearest on every position + data update ──────────────────────────
  useEffect(() => {
    if (!position) { setNearest(null); return }

    // If a specific point is being tracked, use it directly.
    if (trackedPoint) {
      setNearest({
        name:                 trackedPoint.name,
        kind:                 trackedPoint.kind,
        distNm:               distanceNm(position, trackedPoint),
        bearingTrue:          bearingDeg(position, trackedPoint),
        primaryFreq:          null,
        enrouteFreq:          null,
        nearestTwrFreq:       null,
        nearestTwrDistNm:     null,
        nearestTwrControlled: false,
      })
      return
    }

    if (points.length === 0) return

    let best: NearestFeature | null = null
    let bestScore = Infinity  // lower is better
    // Best enroute (FIS/INFO) freq from ANY aerodrome within range, not just the nearest.
    // FIS frequencies are regional — SWEDEN INFORMATION covers the whole country.
    let bestEnrouteFreq: string | null = null
    let bestEnrouteDist  = Infinity
    let bestTwrFreq: string | null = null
    let bestTwrDist  = Infinity
    let bestTwrControlled = false

    for (const pt of points) {
      const dist = distanceNm(position, pt)
      if (dist > MAX_DIST_NM) continue
      // Track nearest enroute freq independently
      if (pt.enrouteFreq && dist < bestEnrouteDist) {
        bestEnrouteDist = dist
        bestEnrouteFreq = pt.enrouteFreq
      }
      // Track nearest TWR/AFIS freq independently
      if (pt.primaryFreq && dist < bestTwrDist) {
        bestTwrDist = dist
        bestTwrFreq = pt.primaryFreq
        bestTwrControlled = pt.primaryFreqControlled
      }
      // Tiny priority tiebreaker so aerodromes win at equal distance
      const score = dist + pt.priority * 0.001
      if (score < bestScore) {
        bestScore = score
        best = {
          name:                 pt.name,
          kind:                 pt.kind,
          distNm:               dist,
          bearingTrue:          bearingDeg(position, pt),
          primaryFreq:          pt.primaryFreq,
          enrouteFreq:          pt.enrouteFreq,
          nearestTwrFreq:       null,
          nearestTwrDistNm:     null,
          nearestTwrControlled: false,
        }
      }
    }

    // Overlay the best regional enroute + nearest TWR onto the nearest feature
    if (best) {
      best = {
        ...best,
        enrouteFreq:         bestEnrouteFreq,
        nearestTwrFreq:      bestTwrFreq,
        nearestTwrDistNm:    bestTwrDist < Infinity ? bestTwrDist : null,
        nearestTwrControlled: bestTwrControlled,
      }
    }

    setNearest(best)
  }, [position, points, trackedPoint])

  return nearest
}
