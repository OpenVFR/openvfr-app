/**
 * Pre-flight planning warnings panel.
 *
 * Renders the warnings from `computeWarnings` (shared with native).
 */

import { useMsaMargins } from '../db/useSettings'
import { resolveMsaMargins } from '@open-vfr/shared/msaMargins'
import { computeWarnings, type PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { fetchTerrainProfileShared } from '@open-vfr/shared/terrainCache'
import { useMefGrids } from '../hooks/useMefGrids'
import { useState, useEffect, useMemo } from 'react'
import {
  buildVirtualRadarProfile,
  computeMsaProfile,
  terrainForMsa,
  applyTerrainToBands,
  terrainAt,
  type VirtualRadarProfile,
  type MsaPoint,
  type TerrainPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { getRemoteDem } from '../utils/terrainDem'
import { API_BASE_URL } from '../utils/env'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType } from '../db/index'
import css from './PreflightWarnings.module.css'
import { loadCountryGeojson, activeCountriesKey } from '@open-vfr/shared/countryData'

// ---------------------------------------------------------------------------
// Module-level GeoJSON cache (loaded once, same pattern as VirtualRadar)
// ---------------------------------------------------------------------------

let _airspaceGeo: GeoJSON.FeatureCollection | null = null
let _obstacleGeo: GeoJSON.FeatureCollection | null = null
let _landmarkGeo: GeoJSON.FeatureCollection | null = null
let _geoKey = ''

function loadGeoJson() {
  // A new country selection drops the cached data.
  if (_geoKey !== activeCountriesKey()) {
    _geoKey = activeCountriesKey()
    _airspaceGeo = null
    _obstacleGeo = null
    _landmarkGeo = null
  }
  const key = _geoKey
  if (!_airspaceGeo) {
    loadCountryGeojson('airspace')
      .then((d) => { if (key === _geoKey) _airspaceGeo = d })
      .catch(() => { /* offline */ })
  }
  if (!_obstacleGeo) {
    loadCountryGeojson('obstacles')
      .then((d) => { if (key === _geoKey) _obstacleGeo = d })
      .catch(() => { /* offline */ })
  }
  if (!_landmarkGeo) {
    // Masts, chimneys etc. count towards the MSA like the chart does.
    loadCountryGeojson('landmarks')
      .then((d) => { if (key === _geoKey) _landmarkGeo = d })
      .catch(() => { /* offline */ })
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraft?:    AircraftProfileDocType
  /** aircraft_profile id stored on the current route, if any — used only to
   *  detect the orphaned-reference case (id set, but `aircraft` undefined). */
  aircraftId?:  string
  /** Effective wind per leg (override > global > forecast), for the fuel check. */
  legWinds?:    ({ dirDeg: number; speedKts: number } | null)[]
}

export default function PreflightWarnings({ waypoints, legOverrides, aircraft, aircraftId, legWinds }: Props) {
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(_airspaceGeo)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(_obstacleGeo)
  const [landmarkGeo, setLandmarkGeo] = useState<GeoJSON.FeatureCollection | null>(_landmarkGeo)
  const [terrainPts,  setTerrainPts]  = useState<TerrainPoint[]>([])
  const [terrainDone, setTerrainDone] = useState(false)
  const [terrainFailed, setTerrainFailed] = useState(false)

  // Prime module-level cache on first mount
  useEffect(() => {
    loadGeoJson()
    // Poll until cache is populated (typically one tick after fetch resolves)
    const id = setInterval(() => {
      if (_airspaceGeo && !airspaceGeo) setAirspaceGeo(_airspaceGeo)
      if (_obstacleGeo && !obstacleGeo) setObstacleGeo(_obstacleGeo)
      if (_landmarkGeo && !landmarkGeo) setLandmarkGeo(_landmarkGeo)
      if (_airspaceGeo && _obstacleGeo && _landmarkGeo) clearInterval(id)
    }, 200)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch terrain + MSA whenever the route changes
  const routeKey = waypoints
    .map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`)
    .join('|')

  useEffect(() => {
    if (waypoints.length < 2) {
      setTerrainPts([])
      setTerrainDone(false)
      setTerrainFailed(false)
      return
    }
    setTerrainDone(false)
    setTerrainFailed(false)
    const ctrl = new AbortController()
    fetchTerrainProfileShared(waypoints, API_BASE_URL, ctrl.signal, getRemoteDem())
      .then((pts) => {
        setTerrainPts(pts)
        setTerrainDone(true)
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setTerrainFailed(true)
          setTerrainDone(true)  // show warnings without MSA rather than hang
        }
      })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const [msaMargins] = useMsaMargins()
  const abeamNm = resolveMsaMargins(msaMargins).abeamNm
  const rawProfile = useMemo<VirtualRadarProfile | null>(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo, undefined, landmarkGeo ?? undefined, Infinity, aircraft?.cruiseAltFt || undefined, { obstacleNm: abeamNm, landmarkNm: abeamNm })
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo, landmarkGeo, aircraft?.cruiseAltFt, abeamNm])
  // AGL limits lifted onto the terrain so the penetration check compares altitudes.
  const profile = useMemo(
    () => rawProfile && { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, terrainPts) },
    [rawProfile, terrainPts],
  )

  const mefGrids = useMefGrids()
  // Fetched terrain, or (once the fetch failed) route samples from the terrain grid.
  const msaTerrain = useMemo(
    () => terrainForMsa(waypoints, terrainPts, mefGrids, msaMargins, terrainFailed),
    [waypoints, terrainPts, mefGrids, msaMargins, terrainFailed],
  )
  const msaPts = useMemo<MsaPoint[]>(
    () => computeMsaProfile(msaTerrain.pts, msaMargins, profile ? obstacleTipsForMsa(profile.obstacles, profile.landmarks, (d) => terrainAt(msaTerrain.pts, d)) : undefined, msaTerrain.corridorFt),
    [msaTerrain, msaMargins, profile],
  )

  const warnings = useMemo<PreflightWarning[]>(() => {
    if (!profile) return []
    return computeWarnings(profile, msaPts, aircraft, waypoints, legOverrides, aircraftId, terrainFailed, legWinds, resolveMsaMargins(msaMargins))
  }, [profile, msaPts, aircraft, waypoints, legOverrides, aircraftId, terrainFailed, legWinds, msaMargins])

  const loading = !terrainDone && waypoints.length >= 2

  if (waypoints.length < 2) return null

  return (
    <div className={css.panel}>
      {loading && (
        <p className={css.loading}>Checking route…</p>
      )}

      {!loading && warnings.length === 0 && (
        <div className={css.ok}>
          <span className={css.okIcon}>✓</span>
          No issues found
        </div>
      )}

      {warnings.map((w, i) => (
        <div
          key={`${w.code}-${i}`}
          className={`${css.card} ${w.level === 'danger' ? css.danger : css.warn}`}
        >
          <div className={css.cardTitle}>
            <span className={css.cardIcon}>{w.level === 'danger' ? '✕' : '!'}</span>
            {w.title}
          </div>
          <div className={css.cardDetail}>{w.detail}</div>
        </div>
      ))}
    </div>
  )
}
