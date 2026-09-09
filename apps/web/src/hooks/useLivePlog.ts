/**
 * useLivePlog — live pilot log state for the in-flight PLOG panel.
 *
 * Tracks actual times of arrival (ATAs) as waypoints are passed, computes
 * live ETAs for upcoming waypoints from current ground speed, calculates
 * progress on the active leg, and finds upcoming comm frequencies and nearby
 * nav aids for the current position.
 */

import { useState, useEffect, useRef } from 'react'
import type { GpsPosition, FlyingMode } from '../utils/gpsTypes'
import type { RouteWaypoint } from '../utils/routeCalc'
import { distanceNm } from '../utils/routeCalc'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// ── Public types ─────────────────────────────────────────────────────────────

export interface UpcomingFreq {
  icao:    string
  name:    string
  service: string
  freq:    string
  distNm:  number
}

export interface NearbyNavaid {
  id:     string
  name:   string
  type:   string
  freq:   string
  distNm: number
}

export interface LivePlogData {
  /** Actual time of arrival at each waypoint, indexed by waypoint index. */
  atas:           (Date | null)[]
  /** Live ETA at each waypoint; null for past waypoints or when GS < 10 kts. */
  liveEtas:       (Date | null)[]
  /** Progress % (0–100) on the current active leg; null when not en-route. */
  legProgressPct: number | null
  /** Upcoming aerodromes with comm frequencies (10-min lookahead, sorted by distance). */
  upcomingFreqs:  UpcomingFreq[]
  /** Nearby VOR/NDB beacons (within 15 NM, sorted by distance). */
  nearbyNavaids:  NearbyNavaid[]
}

// ── GeoJSON caches (loaded once per session) ─────────────────────────────────

type CachedAerodrome = {
  lat: number; lng: number
  icao: string; name: string
  freqs: { service: string; freq: string }[]
}
type CachedNavaid = {
  lat: number; lng: number
  id: string; name: string; type: string; freq: string
}

let _aeroCache: CachedAerodrome[] | null = null
let _navCache:  CachedNavaid[]    | null = null

const COMM_SERVICES = ['TWR', 'AFIS', 'APP', 'DEP', 'GND', 'INFO', 'FIS', 'UNICOM', 'ATIS']
const COMM_PRIORITY = COMM_SERVICES

async function loadAerodromes(): Promise<CachedAerodrome[]> {
  if (_aeroCache) return _aeroCache
  try {
    const fc = await fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson')).then(r => r.json()) as GeoJSON.FeatureCollection
    _aeroCache = fc.features
      .filter(f => f.geometry.type === 'Point')
      .map(f => {
        const g = f.geometry as GeoJSON.Point
        const p = f.properties as { icao?: string; name?: string; frequencies?: unknown }
        const raw: Array<{ service?: string; freq_mhz?: number }> =
          Array.isArray(p.frequencies) ? p.frequencies
          : typeof p.frequencies === 'string' ? JSON.parse(p.frequencies)
          : []
        const freqs = raw
          .filter(x => COMM_SERVICES.includes((x.service ?? '').toUpperCase()))
          .map(x => ({ service: (x.service ?? '').toUpperCase(), freq: x.freq_mhz ? x.freq_mhz.toFixed(3) : '' }))
          .filter(x => x.freq)
        return { lat: g.coordinates[1], lng: g.coordinates[0], icao: String(p.icao ?? ''), name: String(p.name ?? ''), freqs }
      })
      .filter(a => a.freqs.length > 0)
  } catch {
    _aeroCache = []
  }
  return _aeroCache
}

async function loadNavaids(): Promise<CachedNavaid[]> {
  if (_navCache) return _navCache
  try {
    const fc = await fetch(versionedTileUrl(TILES_BASE_URL, 'se-navaids.geojson')).then(r => r.json()) as GeoJSON.FeatureCollection
    _navCache = fc.features
      .filter(f => f.geometry.type === 'Point')
      .map(f => {
        const g = f.geometry as GeoJSON.Point
        const p = f.properties as { id?: string; name?: string; navaid_type?: string; freq_str?: string }
        return {
          lat: g.coordinates[1], lng: g.coordinates[0],
          id:   String(p.id ?? ''),
          name: String(p.name ?? ''),
          type: String(p.navaid_type ?? ''),
          freq: String(p.freq_str ?? ''),
        }
      })
      .filter(n => n.freq && n.type !== 'MARKER')
  } catch {
    _navCache = []
  }
  return _navCache
}

// ── Distance helper ────────────────────────────────────────────────────────

/** Total distance from pos → wps[activeIdx] → ... → wps[targetIdx] */
function distToWpIdx(
  pos: { lat: number; lng: number },
  wps: RouteWaypoint[],
  activeIdx: number,
  targetIdx: number,
): number {
  if (targetIdx < activeIdx || wps.length === 0) return 0
  let d = distanceNm(pos, wps[activeIdx])
  for (let j = activeIdx; j < targetIdx; j++) {
    d += distanceNm(wps[j], wps[j + 1])
  }
  return d
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const EMPTY: LivePlogData = { atas: [], liveEtas: [], legProgressPct: null, upcomingFreqs: [], nearbyNavaids: [] }

export function useLivePlog(
  gpsPosition:    GpsPosition | null,
  flyingMode:     FlyingMode,
  routeWaypoints: RouteWaypoint[],
  activeWpIdx:    number,
): LivePlogData {
  const flying = flyingMode !== 'off'
  const n = routeWaypoints.length

  // ── ATA tracking ────────────────────────────────────────────────────────
  // useRef to avoid triggering renders just from mutation; ataVersion bumps
  // trigger a re-render so the panel reflects the new time.
  const atasRef           = useRef<(Date | null)[]>([])
  const prevActiveIdxRef  = useRef<number>(-1)
  const prevFlyingRef     = useRef<boolean>(false)
  const [ataVersion, setAtaVersion] = useState(0)

  // Reset when route changes (new destination set or route cleared)
  const prevNRef = useRef(0)
  useEffect(() => {
    if (prevNRef.current !== n) {
      prevNRef.current      = n
      atasRef.current       = new Array(n).fill(null)
      prevActiveIdxRef.current = activeWpIdx
      setAtaVersion(v => v + 1)
    }
  }, [n, activeWpIdx])

  // Record ATA on takeoff and on each waypoint passage
  useEffect(() => {
    if (!flying) {
      prevFlyingRef.current = false
      return
    }
    // Takeoff: flying just became true
    if (!prevFlyingRef.current && n > 0) {
      atasRef.current = [...atasRef.current] // shallow copy so reference changes
      atasRef.current[0] = new Date()
      prevActiveIdxRef.current = activeWpIdx
      setAtaVersion(v => v + 1)
    }
    prevFlyingRef.current = true

    // Waypoint passage: activeWpIdx advanced
    if (prevActiveIdxRef.current !== activeWpIdx && prevActiveIdxRef.current >= 1) {
      const passed = prevActiveIdxRef.current
      if (passed < n) {
        atasRef.current = [...atasRef.current]
        atasRef.current[passed] = new Date()
        setAtaVersion(v => v + 1)
      }
    }
    prevActiveIdxRef.current = activeWpIdx
  }, [flying, activeWpIdx, n])

  // ── Frequency data (updated ~every 1 NM of movement) ─────────────────────
  const [upcomingFreqs, setUpcomingFreqs] = useState<UpcomingFreq[]>([])
  const [nearbyNavaids, setNearbyNavaids] = useState<NearbyNavaid[]>([])

  // Coarse-quantised position key (re-runs freq scan every ~1 NM movement)
  const posKey = gpsPosition
    ? `${Math.round(gpsPosition.lat * 60)}:${Math.round(gpsPosition.lng * 60)}`
    : null

  useEffect(() => {
    if (!flying || !gpsPosition) {
      setUpcomingFreqs([])
      setNearbyNavaids([])
      return
    }
    const pos = gpsPosition
    const gs = Math.max(10, pos.speedKts)
    const lookaheadNm = (gs / 60) * 10  // 10-minute lookahead

    // Sample upcoming route: pos → wps up to lookaheadNm ahead
    const upcomingPts: { lat: number; lng: number }[] = [pos]
    let accumulated = 0
    for (let i = activeWpIdx; i < routeWaypoints.length; i++) {
      const prev = i === activeWpIdx ? pos : routeWaypoints[i - 1]
      accumulated += distanceNm(prev, routeWaypoints[i])
      upcomingPts.push(routeWaypoints[i])
      if (accumulated >= lookaheadNm) break
    }

    Promise.all([loadAerodromes(), loadNavaids()]).then(([aerodromes, navaids]) => {
      // ── Upcoming comms ──────────────────────────────────────────────────
      const LATERAL_NM = 10
      const seen = new Set<string>()
      const freqs: UpcomingFreq[] = []

      for (const ad of aerodromes) {
        if (seen.has(ad.icao)) continue
        const minDist = Math.min(...upcomingPts.map(pt => distanceNm(pt, ad)))
        if (minDist > LATERAL_NM) continue
        seen.add(ad.icao)
        const best = [...ad.freqs].sort(
          (a, b) => COMM_PRIORITY.indexOf(a.service) - COMM_PRIORITY.indexOf(b.service)
        )[0]
        if (best) freqs.push({ icao: ad.icao, name: ad.name, service: best.service, freq: best.freq, distNm: Math.round(minDist * 10) / 10 })
      }
      freqs.sort((a, b) => a.distNm - b.distNm)
      setUpcomingFreqs(freqs.slice(0, 5))

      // ── Nearby navaids ──────────────────────────────────────────────────
      const NAVAID_NM = 15
      const nearby = navaids
        .map(n => ({ ...n, distNm: Math.round(distanceNm(pos, n) * 10) / 10 }))
        .filter(n => n.distNm <= NAVAID_NM)
        .sort((a, b) => a.distNm - b.distNm)
        .slice(0, 4)
      setNearbyNavaids(nearby)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flying, posKey, activeWpIdx])

  // ── Derived: live ETAs + leg progress (computed from current render data) ─
  if (!flying || n < 2) return EMPTY

  const pos = gpsPosition
  const gs  = pos?.speedKts ?? 0
  const atas = atasRef.current

  // Live ETAs
  const liveEtas: (Date | null)[] = routeWaypoints.map((_, i) => {
    if (i < activeWpIdx || !pos || gs < 10) return null
    const dist = distToWpIdx(pos, routeWaypoints, activeWpIdx, i)
    return new Date(Date.now() + (dist / gs) * 3_600_000)
  })

  // Leg progress
  let legProgressPct: number | null = null
  if (pos && activeWpIdx > 0 && activeWpIdx < n) {
    const legFrom = routeWaypoints[activeWpIdx - 1]
    const legTo   = routeWaypoints[activeWpIdx]
    const legDist = distanceNm(legFrom, legTo)
    if (legDist > 0.01) {
      const remaining = distanceNm(pos, legTo)
      legProgressPct  = Math.min(100, Math.max(0, (1 - remaining / legDist) * 100))
    }
  }

  // Silence the ataVersion dependency warning — it's intentionally used to
  // ensure the component re-renders when ATAs change.
  void ataVersion

  return { atas, liveEtas, legProgressPct, upcomingFreqs, nearbyNavaids }
}
