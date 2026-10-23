/**
 * Pre-flight planning warnings panel.
 *
 * Checks for three categories of issue:
 *   1. Airspace penetration — planned altitude enters Class C / D / R / TRA
 *   2. Below Minimum Safe Altitude — planned altitude < the MSA (terrain + terrain clearance, obstacles + obstacle clearance; user margins)
 *      (outside the 5 NM departure/arrival suppression window)
 *   3. Fuel — total minimum fuel exceeds available fuel (based on aircraft profile)
 */

import { useMsaMargins } from '../db/useSettings'
import { resolveMsaMargins, DEFAULT_MSA_MARGINS, type MsaMargins } from '@open-vfr/shared/msaMargins'
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
import { computeFuelPlan } from '../utils/fuelCalc'
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
// Warning types
// ---------------------------------------------------------------------------

export type WarningLevel = 'danger' | 'warn'

export interface PreflightWarning {
  level:  WarningLevel
  code:   string
  title:  string
  detail: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTROLLED_CLASSES = new Set(['C', 'D'])
const RESTRICTED_CLASSES = new Set(['R', 'TRA'])
const DEFAULT_ALT_FT = 3500
const SUPPRESS_DEP_ARR_NM = 5  // ignore MSA violations within 5 NM of dep/arr

/** Return planned altitude at a given route distance using the step-function profile. */
function plannedAltAt(profile: VirtualRadarProfile, distNm: number): number {
  let alt = DEFAULT_ALT_FT
  for (const p of profile.altitudeProfile) {
    if (p.distNm <= distNm) alt = p.altFt
    else break
  }
  return alt
}

/** Return lowest MSA value at a given route distance. */
function msaAt(msaPts: MsaPoint[], distNm: number): number {
  let msa = 0
  for (const p of msaPts) {
    if (p.distNm <= distNm) msa = p.msaFt
    else break
  }
  return msa
}

// ---------------------------------------------------------------------------
// Warning computation
// ---------------------------------------------------------------------------

function computeWarnings(
  profile:  VirtualRadarProfile,
  msaPts:   MsaPoint[],
  aircraft: AircraftProfileDocType | undefined,
  waypoints: RouteWaypoint[],
  legOverrides: LegOverride[],
  aircraftId?: string,
  terrainFailed = false,
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[],
  margins: MsaMargins = DEFAULT_MSA_MARGINS,
): PreflightWarning[] {
  const warnings: PreflightWarning[] = []

  // ── Terrain unavailable: the MSA check below is silently skipped and AGL
  // airspace limits are compared at their raw height. Say so rather than
  // let an empty list read as "all clear".
  if (terrainFailed) {
    warnings.push({
      level:  'warn',
      code:   'terrain-unavailable',
      title:  'Terrain data unavailable',
      detail: msaPts.length > 0
        ? 'No elevation data for this route: the Minimum Safe Altitude check uses the terrain maximum grid (highest terrain per ~460 m cell, so conservative) and airspace limits given above ground (AGL) are checked at their raw height.'
        : 'No elevation data for this route: the Minimum Safe Altitude check was skipped and airspace limits given above ground (AGL) are checked at their raw height.',
    })
  }

  // ── 0. Aircraft profile referenced by this route no longer exists ──────
  // (route.aircraftId set, but no matching aircraft_profiles doc — e.g. the
  // profile was deleted on another device after this route was saved with it)
  if (aircraftId && !aircraft) {
    warnings.push({
      level:  'warn',
      code:   'aircraft-profile-missing',
      title:  'Aircraft profile no longer exists',
      detail: 'This route was planned with an aircraft profile that has since been deleted. Fuel and weight & balance calculations are unavailable until you pick a different aircraft.',
    })
  }

  // ── 1. Airspace penetration ─────────────────────────────────────────────
  // The route can cross one airspace twice (it is one band per crossing): warn once per airspace and vertical extent.
  const penetrationSeen = new Set<string>()
  for (const band of profile.airspaceBands) {
    const isDangerous =
      CONTROLLED_CLASSES.has(band.class) || RESTRICTED_CLASSES.has(band.class)
    if (!isDangerous) continue

    // Sample planned altitude at the midpoint of the airspace crossing
    const midNm    = (band.entryNm + band.exitNm) / 2
    const planned  = plannedAltAt(profile, midNm)

    // Flag if planned altitude is INSIDE the vertical extent (flying through)
    if (planned >= band.lower_ft && planned <= band.upper_ft) {
      const seenKey = `${band.class}|${band.name}|${band.lower_ft}|${band.upper_ft}`
      if (penetrationSeen.has(seenKey)) continue
      penetrationSeen.add(seenKey)
      const level = RESTRICTED_CLASSES.has(band.class) ? 'danger' : 'warn'
      const classLabel = band.type === 'CTR' ? `Class ${band.class} CTR` : `Class ${band.class}`
      warnings.push({
        level,
        code:   'airspace-penetration',
        title:  `${classLabel} penetration — ${band.name}`,
        detail: `Planned altitude ${planned.toLocaleString()} ft enters ${band.lower_ft.toLocaleString()}–${band.upper_ft.toLocaleString()} ft`,
      })
    }
  }

  // ── 2. Below Minimum Safe Altitude ──────────────────────────────────────
  if (msaPts.length > 0 && profile.totalNm > 0) {
    let belowMsa = false
    // Sample every 0.5 NM; skip within SUPPRESS_DEP_ARR_NM of dep/arr
    const step = 0.5
    for (let d = SUPPRESS_DEP_ARR_NM; d <= profile.totalNm - SUPPRESS_DEP_ARR_NM; d += step) {
      const msa     = msaAt(msaPts, d)
      const planned = plannedAltAt(profile, d)
      if (msa > 0 && planned < msa) {
        belowMsa = true
        break
      }
    }
    if (belowMsa) {
      warnings.push({
        level:  'danger',
        code:   'below-msa',
        title:  'Route segment below Minimum Safe Altitude',
        detail: `Planned altitude on one or more legs falls below the minimum safe altitude (terrain + ${margins.terrainClearanceFt.toLocaleString('en-US')} ft within ${margins.abeamNm} NM, obstacles + ${margins.obstacleClearanceFt.toLocaleString('en-US')} ft). Check Virtual Radar.`,
      })
    }
  }

  // ── 3. Fuel ─────────────────────────────────────────────────────────────
  if (aircraft && waypoints.length >= 2) {
    const plan = computeFuelPlan(waypoints, legOverrides, aircraft, legWinds)
    if (plan.availableFuelL > 0) {
      if (plan.totalMinFuelL > plan.availableFuelL) {
        warnings.push({
          level:  'danger',
          code:   'fuel-insufficient',
          title:  'Insufficient fuel',
          detail: `Requires ${plan.totalMinFuelL.toFixed(1)} L — available ${plan.availableFuelL.toFixed(1)} L`,
        })
      } else if (plan.totalMinFuelL > plan.availableFuelL * 0.85) {
        warnings.push({
          level:  'warn',
          code:   'fuel-tight',
          title:  'Tight fuel margin',
          detail: `Requires ${plan.totalMinFuelL.toFixed(1)} L of ${plan.availableFuelL.toFixed(1)} L available`,
        })
      }
    }
  }

  return warnings
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
