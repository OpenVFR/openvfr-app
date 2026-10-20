/**
 * useAutoCruiseLevel — gives a newly appended/inserted route leg a safe
 * altitude. Mirrors the web hook of the same name.
 *
 * On every waypoint change that is a single append/insert
 * (@open-vfr/shared/autoCruiseLevel newLegsAfterChange), the terrain under
 * each new leg and the obstacles in its corridor are looked up. If the leg's
 * planned altitude (its override, else the aircraft cruise altitude) is
 * below the required level, the override is raised and `onNotice` is
 * called with a one-line explanation. Legs the user already levelled, or
 * whose endpoints merely moved, are never changed.
 */

import { useEffect, useRef } from 'react'
import { buildVirtualRadarProfile, terrainAt, terrainForMsa } from '@open-vfr/shared/virtualRadarCalc'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { useMefGrids } from './useMefGrids'
import { requiredLegAltFt, newLegsAfterChange, autoLevelMessage } from '@open-vfr/shared/autoCruiseLevel'
import { resolveMsaMargins, type MsaMargins } from '@open-vfr/shared/msaMargins'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { getTileUrls, API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import type { RouteWaypoint, LegOverride } from '../types/db'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

// Obstacles file (0.5-3 MB, fine for fetch() on native -- see AGENTS.md on
// large GeoJSON). Parsed once per URL, like VerticalProfile's own cache.
let _obstacles: { url: string; p: Promise<GeoJSON.FeatureCollection> } | null = null
export function loadObstacles(): Promise<GeoJSON.FeatureCollection> {
  const url = getTileUrls().obstacles
  if (!_obstacles || _obstacles.url !== url) {
    const p = fetch(url).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
    p.catch(() => { if (_obstacles?.p === p) _obstacles = null })
    _obstacles = { url, p }
  }
  return _obstacles.p
}

// Landmarks (masts, chimneys...) count towards the MSA like the chart does.
let _landmarks: { url: string; p: Promise<GeoJSON.FeatureCollection> } | null = null
export function loadLandmarks(): Promise<GeoJSON.FeatureCollection> {
  const url = getTileUrls().landmarks
  if (!_landmarks || _landmarks.url !== url) {
    const p = fetch(url).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
    p.catch(() => { if (_landmarks?.p === p) _landmarks = null })
    _landmarks = { url, p }
  }
  return _landmarks.p
}

export function useAutoCruiseLevel(opts: {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  setLegOverride: (idx: number, override: LegOverride) => void
  /** Planned altitude for legs without an override. */
  defaultAltFt: number
  onNotice: (text: string) => void
  /** Off while flying: the route is being followed, not planned. */
  enabled: boolean
  msaMargins?: Partial<MsaMargins>
}) {
  const { waypoints, legOverrides, setLegOverride, defaultAltFt, onNotice, enabled, msaMargins } = opts
  const prevRef = useRef<RouteWaypoint[]>(waypoints)
  const mefGrids = useMefGrids()
  // Latest values for the async work below.
  const latest = useRef({ waypoints, legOverrides, defaultAltFt, onNotice, setLegOverride, msaMargins, mefGrids })
  latest.current = { waypoints, legOverrides, defaultAltFt, onNotice, setLegOverride, msaMargins, mefGrids }

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = waypoints
    if (!enabled) return
    const legs = newLegsAfterChange(prev, waypoints)
    if (legs.length === 0) return
    for (const legIndex of legs) {
      const legWps = [waypoints[legIndex], waypoints[legIndex + 1]]
      Promise.all([
        fetchTerrainProfileShared(legWps, API_BASE, undefined, getOfflineDem()).catch(() => []),
        loadObstacles().catch(() => EMPTY_FC),
        loadLandmarks().catch(() => EMPTY_FC),
      ]).then(([terrain, obstacles, landmarks]) => {
        // Stale if the leg's endpoints changed while the lookup ran (or the
        // route went away).
        const now = latest.current.waypoints
        const same = (a?: RouteWaypoint, b?: RouteWaypoint) => !!a && !!b && a.lat === b.lat && a.lng === b.lng
        if (!same(now[legIndex], legWps[0]) || !same(now[legIndex + 1], legWps[1])) return
        const profile = buildVirtualRadarProfile(legWps, [], EMPTY_FC, obstacles, undefined, landmarks, Infinity, undefined, { obstacleNm: resolveMsaMargins(latest.current.msaMargins).abeamNm, landmarkNm: resolveMsaMargins(latest.current.msaMargins).abeamNm })
        // Fetched terrain, or (fetch failed) route samples from the terrain grid.
        const tt = terrainForMsa(legWps, terrain, latest.current.mefGrids, latest.current.msaMargins, true)
        const tips = obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(tt.pts, d)).map((o) => o.elevationFt)
        // Corridor maximum (offline grid) as well as the centreline, like the chart's MSA.
        const elev = tt.pts.map((p, i) => Math.max(p.elevFt, tt.corridorFt[i] ?? 0))
        const required = requiredLegAltFt(elev, tips, latest.current.msaMargins)
        const { legOverrides, defaultAltFt, onNotice, setLegOverride } = latest.current
        const planned = legOverrides[legIndex]?.altFt ?? defaultAltFt
        if (required <= planned) return
        setLegOverride(legIndex, { ...(legOverrides[legIndex] ?? {}), altFt: required })
        const name = (i: number) => now[i]?.name ?? `WP${i + 1}`
        onNotice(autoLevelMessage(name(legIndex), name(legIndex + 1), required))
      }).catch(() => { /* lookup failed: leave the leg as planned */ })
    }
  // Only waypoint identity changes matter; the rest is read through `latest`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints, enabled])
}
