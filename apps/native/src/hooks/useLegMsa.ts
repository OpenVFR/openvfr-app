/**
 * useLegMsa (native) — minimum safe altitude of every route leg for the plan
 * screen's leg list and leg panel. Same inputs as the vertical profile's MSA
 * line: terrain along the route (elevation API, offline DEM fallback), the
 * abeam corridor maximum from the offline grid when available, obstacle tips
 * on the route, and the user's margins. See web hooks/useLegMsa.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { useSettled, ROUTE_SETTLE_MS } from './useSettled'
import {
  buildVirtualRadarProfile, computeMsaProfile, terrainForMsa, legCorridorMsaFt,
  getMsaLookup, terrainAt, type TerrainPoint, type MsaPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { legSpans, legMsaList, type LegSpan } from '@open-vfr/shared/legLevelDrag'
import { resolveMsaMargins, type MsaMargins } from '@open-vfr/shared/msaMargins'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { API_BASE } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { loadObstacles, loadLandmarks } from './useAutoCruiseLevel'
import { useMefGrids } from './useMefGrids'
import type { RouteWaypoint } from '../types/db'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export type LegMsa = {
  legMsa: number[]; spans: LegSpan[]; totalNm: number
  /** MSA along the route, with the terrain it was built from: reused by the pre-flight check instead of computing them again. */
  msaPts: MsaPoint[]
  terrain: TerrainPoint[]
  terrainFailed: boolean
  /** The route (settled) these values belong to. */
  waypoints: RouteWaypoint[]
  /** Terrain for `waypoints` has arrived (or failed) and the values are final. */
  ready: boolean
  /** The obstacle or landmark file did not load: obstacle clearance was not checked. */
  obstaclesFailed: boolean
}
const NO_WAYPOINTS: RouteWaypoint[] = []
const NONE: LegMsa = { legMsa: [], spans: [], totalNm: 0, msaPts: [], terrain: [], terrainFailed: false, waypoints: NO_WAYPOINTS, ready: false, obstaclesFailed: false }

export function useLegMsa(liveWaypoints: RouteWaypoint[], margins: Partial<MsaMargins>): LegMsa {
  // The plan screen stays mounted behind the map: wait for the route to be still
  // (dragging a leg, undo/redo), and keep the last result while the screen is not in front.
  const focused = useIsFocused()
  const waypoints = useSettled(liveWaypoints, ROUTE_SETTLE_MS, !focused)
  const [terrain, setTerrain] = useState<TerrainPoint[]>([])
  const [failed, setFailed] = useState(false)
  const [doneKey, setDoneKey] = useState('')
  const [obstaclesFailed, setObstaclesFailed] = useState(false)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const grids = useMefGrids()

  useEffect(() => {
    loadObstacles().then(setObstacleGeo).catch(() => { setObstacleGeo(EMPTY_FC); setObstaclesFailed(true) })
    loadLandmarks().then(setLandmarkGeo).catch(() => { setLandmarkGeo(EMPTY_FC); setObstaclesFailed(true) })
  }, [])

  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  useEffect(() => {
    setFailed(false)
    if (waypoints.length < 2) { setTerrain([]); return }
    const ctrl = new AbortController()
    fetchTerrainProfileShared(waypoints, API_BASE, ctrl.signal, getOfflineDem())
      .then((pts) => { setTerrain(pts); setDoneKey(routeKey) })
      .catch(() => { if (!ctrl.signal.aborted) { setTerrain([]); setFailed(true); setDoneKey(routeKey) } })
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
    // Fetched terrain, or (once the fetch failed, e.g. offline without the hillshade DEM)
    // route samples from the terrain grid.
    const t = terrainForMsa(waypoints, terrain, grids, margins, failed)
    if (!profile || t.pts.length === 0) return { ...NONE, waypoints, obstaclesFailed }
    const obstacles = obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(t.pts, d))
    const msaPts = computeMsaProfile(t.pts, margins, obstacles, t.corridorFt)
    const spans = legSpans(profile.altitudeProfile)
    // Floor per leg: its whole corridor incl. the circles around its ends.
    const floors = legCorridorMsaFt(waypoints, grids, margins, obstacles)
    return {
      legMsa: legMsaList(spans, msaPts, getMsaLookup(msaPts), floors), spans, totalNm: profile.totalNm,
      msaPts, terrain, terrainFailed: failed, waypoints, ready: doneKey === routeKey, obstaclesFailed,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, terrain, failed, grids, margins, routeKey, doneKey, obstaclesFailed])
}
