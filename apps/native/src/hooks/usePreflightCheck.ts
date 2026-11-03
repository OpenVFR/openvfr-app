/**
 * usePreflightCheck (native) — the pre-flight warnings and prompts for the
 * planned route. Gathers the inputs (terrain, airspace, obstacles, landmarks,
 * aerodromes, terrain-maximum grid, regional NOTAMs, the user's margins and
 * airspace levels) and hands them to the shared pure functions, exactly as the
 * web panel does (see apps/web/src/components/PreflightWarnings.tsx).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  buildVirtualRadarProfile, computeMsaProfile, terrainForMsa, applyTerrainToBands, terrainAt,
  type TerrainPoint, type VirtualRadarProfile, type MsaPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { computeWarnings, type PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import { computePrompts, type PreflightPrompt } from '@open-vfr/shared/preflightPrompts'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { resolveAirspaceLevels } from '@open-vfr/shared/airspaceAlertLevel'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { notamRegionsFor } from '@open-vfr/shared/notamRegionScope'
import { isIfrOnly } from '@open-vfr/shared/notamRelevance'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'
import { API_BASE, getTileUrls } from '../config'
import { getOfflineDem } from '../utils/terrainDem'
import { loadGeoJsonOnce } from '../utils/geoJsonCache'
import { loadObstacles, loadLandmarks } from './useAutoCruiseLevel'
import { useMefGrids } from './useMefGrids'
import { useCountries } from './useCountries'
import { useRegionalNotams } from './useRegionalNotams'
import { useSettingsContext } from '../context/SettingsContext'
import { useAuthContext } from '../context/AuthContext'
import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from '../types/db'

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export interface PreflightCheck {
  warnings: PreflightWarning[]
  prompts:  PreflightPrompt[]
  /** Terrain and the data files are still loading. */
  loading:  boolean
}

export function usePreflightCheck(opts: {
  waypoints: RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft: AircraftProfileDocType | null
  aircraftId: string | null
  legWinds: ({ dirDeg: number; speedKts: number } | null)[]
  windsLoading: boolean
  enabled: boolean
}): PreflightCheck {
  const { waypoints, legOverrides, aircraft, aircraftId, legWinds, windsLoading, enabled } = opts
  const { settings } = useSettingsContext()
  const { state: authState } = useAuthContext()
  const { selected: selectedCountries } = useCountries()
  const active = enabled && waypoints.length >= 2

  const [countryTick, setCountryTick] = useState(0)
  useEffect(() => onActiveCountriesChange(() => setCountryTick((t) => t + 1)), [])

  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  const [aerodromeGeo, setAerodromeGeo] = useState<GeoJSON.FeatureCollection | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    const urls = getTileUrls()
    loadGeoJsonOnce(urls.airspace).then((d) => alive && setAirspaceGeo(d)).catch(() => alive && setAirspaceGeo(EMPTY_FC))
    loadObstacles().then((d) => alive && setObstacleGeo(d)).catch(() => alive && setObstacleGeo(EMPTY_FC))
    loadLandmarks().then((d) => alive && setLandmarkGeo(d)).catch(() => alive && setLandmarkGeo(EMPTY_FC))
    loadGeoJsonOnce(urls.aerodromes).then((d) => alive && setAerodromeGeo(d)).catch(() => alive && setAerodromeGeo(null))
    return () => { alive = false }
  }, [active, countryTick])

  const [terrainPts, setTerrainPts] = useState<TerrainPoint[]>([])
  const [terrainDone, setTerrainDone] = useState(false)
  const [terrainFailed, setTerrainFailed] = useState(false)
  const routeKey = waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join('|')
  useEffect(() => {
    setTerrainFailed(false)
    if (!active) { setTerrainPts([]); setTerrainDone(false); return }
    setTerrainDone(false)
    const ctrl = new AbortController()
    fetchTerrainProfileShared(waypoints, API_BASE, ctrl.signal, getOfflineDem())
      .then((pts) => { setTerrainPts(pts); setTerrainDone(true) })
      .catch(() => { if (!ctrl.signal.aborted) { setTerrainPts([]); setTerrainFailed(true); setTerrainDone(true) } })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, routeKey])

  const margins = settings.msaMargins
  const abeamNm = resolveMsaMargins(margins).abeamNm
  const airspaceLevels = useMemo(() => resolveAirspaceLevels(settings.alertAirspaceLevels), [settings.alertAirspaceLevels])
  const grids = useMefGrids()

  const rawProfile = useMemo<VirtualRadarProfile | null>(() => {
    if (!active || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(
      waypoints, legOverrides, airspaceGeo, obstacleGeo, undefined, landmarkGeo ?? undefined, Infinity,
      aircraft?.cruiseAltFt || undefined, { obstacleNm: abeamNm, landmarkNm: abeamNm },
    )
  }, [active, waypoints, legOverrides, airspaceGeo, obstacleGeo, landmarkGeo, aircraft?.cruiseAltFt, abeamNm])
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  const msaTerrain = useMemo(
    () => terrainForMsa(waypoints, terrainPts, grids, margins, terrainFailed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeKey, terrainPts, grids, margins, terrainFailed],
  )
  const msaPts = useMemo<MsaPoint[]>(
    () => computeMsaProfile(
      msaTerrain.pts, margins,
      profile ? obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(msaTerrain.pts, d)) : undefined,
      msaTerrain.corridorFt,
    ),
    [msaTerrain, margins, profile],
  )

  // Regional NOTAMs for the countries the route touches.
  const notamRegions = useMemo(
    () => notamRegionsFor({ selected: selectedCountries, route: waypoints }),
    [selectedCountries, waypoints],
  )
  const regionalNotams = useRegionalNotams(active && authState.status === 'authenticated', notamRegions)
  const vfrNotams = useMemo(() => regionalNotams.filter((n) => !isIfrOnly(n)), [regionalNotams])

  const warnings = useMemo<PreflightWarning[]>(() => {
    if (!profile) return []
    return computeWarnings(
      profile, msaPts, aircraft ?? undefined, waypoints, legOverrides, aircraftId ?? undefined,
      terrainFailed, legWinds, resolveMsaMargins(margins),
      { terrainPts, airspaceLevels, aerodromes: aerodromeGeo, notams: vfrNotams, airspace: airspaceGeo },
    )
  }, [profile, msaPts, aircraft, waypoints, legOverrides, aircraftId, terrainFailed, legWinds, margins, terrainPts, airspaceLevels, aerodromeGeo, vfrNotams, airspaceGeo])

  const prompts = useMemo(
    () => computePrompts({ waypoints, legWinds, windsLoading }),
    [waypoints, legWinds, windsLoading],
  )

  return { warnings, prompts, loading: active && (!terrainDone || !profile) }
}
