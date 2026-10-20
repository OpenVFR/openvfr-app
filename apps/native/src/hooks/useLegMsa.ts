/**
 * useLegMsa (native) — minimum safe altitude of every route leg for the plan
 * screen's leg list and leg panel. Same inputs as the vertical profile's MSA
 * line: terrain along the route (elevation API, offline DEM fallback), the
 * abeam corridor maximum from the offline grid when available, obstacle tips
 * on the route, and the user's margins. See web hooks/useLegMsa.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  fetchTerrainProfile, buildVirtualRadarProfile, computeMsaProfile, corridorTerrainAlongRoute,
  getMsaLookup, terrainAt, type TerrainPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { legSpans, legMsaList, type LegSpan } from '@open-vfr/shared/legLevelDrag'
import { resolveMsaMargins, type MsaMargins } from '@open-vfr/shared/msaMargins'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { loadObstacles, loadLandmarks } from './useAutoCruiseLevel'
import { useMefGrids } from './useMefGrids'
import type { RouteWaypoint } from '../types/db'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export type LegMsa = { legMsa: number[]; spans: LegSpan[]; totalNm: number }
const NONE: LegMsa = { legMsa: [], spans: [], totalNm: 0 }

export function useLegMsa(waypoints: RouteWaypoint[], margins: Partial<MsaMargins>): LegMsa {
  const [terrain, setTerrain] = useState<TerrainPoint[]>([])
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const grids = useMefGrids()

  useEffect(() => {
    loadObstacles().then(setObstacleGeo).catch(() => setObstacleGeo(EMPTY_FC))
    loadLandmarks().then(setLandmarkGeo).catch(() => setLandmarkGeo(EMPTY_FC))
  }, [])

  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  useEffect(() => {
    if (waypoints.length < 2) { setTerrain([]); return }
    const ctrl = new AbortController()
    fetchTerrainProfile(waypoints, API_BASE, ctrl.signal, getOfflineDem())
      .then(setTerrain)
      .catch(() => { if (!ctrl.signal.aborted) setTerrain([]) })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  // Geometry and obstacles only: airspace and level overrides do not change
  // leg spans or obstacle positions.
  const profile = useMemo(
    () => waypoints.length < 2 || !obstacleGeo
      ? null
      : buildVirtualRadarProfile(waypoints, [], EMPTY_FC, obstacleGeo, undefined, landmarkGeo ?? undefined, Infinity, undefined, { obstacleNm: resolveMsaMargins(margins).abeamNm, landmarkNm: resolveMsaMargins(margins).abeamNm }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeKey, obstacleGeo, landmarkGeo, margins.abeamNm],
  )

  return useMemo(() => {
    if (!profile || terrain.length === 0) return NONE
    const corridor = corridorTerrainAlongRoute(waypoints, terrain, grids, margins)
    const msaPts = computeMsaProfile(terrain, margins, obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(terrain, d)), corridor)
    const spans = legSpans(profile.altitudeProfile)
    return { legMsa: legMsaList(spans, msaPts, getMsaLookup(msaPts)), spans, totalNm: profile.totalNm }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, terrain, grids, margins, routeKey])
}
