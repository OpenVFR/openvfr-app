/**
 * useLegMsa (web) — minimum safe altitude of every route leg, for the leg
 * table and leg panel (not the chart, which computes its own from the same
 * inputs). Terrain along the route (elevation API, DEM fallback), the abeam
 * corridor maximum from the offline grid when available, and the obstacle
 * tips on the route, combined with the user's margins exactly like the
 * Virtual Radar MSA line.
 *
 * Returns per-leg MSA (ft, 0 = unknown), the leg spans (NM along the route)
 * and the route length, so callers can decide whether a planned level is
 * below MSA with `legBelowMsa` (same endpoint rule as the chart).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  fetchTerrainProfile, buildVirtualRadarProfile, computeMsaProfile, corridorTerrainAlongRoute,
  getMsaLookup, type TerrainPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { legSpans, legMsaList, type LegSpan } from '@open-vfr/shared/legLevelDrag'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import { getRemoteDem } from '../utils/terrainDem'
import { useActiveCountries } from '../utils/countryData'
import { API_BASE_URL } from '../utils/env'
import { useMsaMargins } from '../db/useSettings'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { useMefGrids } from './useMefGrids'
import type { RouteWaypoint } from '../utils/routeCalc'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export type LegMsa = { legMsa: number[]; spans: LegSpan[]; totalNm: number }
const NONE: LegMsa = { legMsa: [], spans: [], totalNm: 0 }

export function useLegMsa(waypoints: RouteWaypoint[]): LegMsa {
  const [terrain, setTerrain] = useState<TerrainPoint[]>([])
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [margins] = useMsaMargins()
  const grids = useMefGrids()
  const { key: countriesKey } = useActiveCountries()

  useEffect(() => {
    loadCountryGeojson('obstacles').then(setObstacleGeo).catch(() => setObstacleGeo(EMPTY_FC))
  }, [countriesKey])

  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  useEffect(() => {
    if (waypoints.length < 2) { setTerrain([]); return }
    const ctrl = new AbortController()
    fetchTerrainProfile(waypoints, API_BASE_URL, ctrl.signal, getRemoteDem())
      .then(setTerrain)
      .catch(() => { if (!ctrl.signal.aborted) setTerrain([]) })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  // Geometry and obstacles only: the airspace set and level overrides do not
  // change spans or obstacle positions.
  const profile = useMemo(
    () => waypoints.length < 2 || !obstacleGeo
      ? null
      : buildVirtualRadarProfile(waypoints, [], EMPTY_FC, obstacleGeo, undefined, undefined, Infinity, undefined, { obstacleNm: resolveMsaMargins(margins).abeamNm }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeKey, obstacleGeo, margins.abeamNm],
  )

  return useMemo(() => {
    if (!profile || terrain.length === 0) return NONE
    const corridor = corridorTerrainAlongRoute(waypoints, terrain, grids, margins)
    const msaPts = computeMsaProfile(terrain, margins, profile.obstacles, corridor)
    const spans = legSpans(profile.altitudeProfile)
    return { legMsa: legMsaList(spans, msaPts, getMsaLookup(msaPts)), spans, totalNm: profile.totalNm }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, terrain, grids, margins, routeKey])
}
