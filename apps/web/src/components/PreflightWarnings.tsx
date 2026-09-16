/**
 * Pre-flight planning warnings panel.
 *
 * Checks for three categories of issue:
 *   1. Airspace penetration — planned altitude enters Class C / D / R / TRA
 *   2. Below Minimum Safe Altitude — planned altitude < terrain + 1,000 ft
 *      (outside the 5 NM departure/arrival suppression window)
 *   3. Fuel — total minimum fuel exceeds available fuel (based on aircraft profile)
 */

import { useState, useEffect, useMemo } from 'react'
import {
  buildVirtualRadarProfile,
  fetchTerrainProfile,
  computeMsaProfile,
  type VirtualRadarProfile,
  type MsaPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { computeFuelPlan } from '../utils/fuelCalc'
import type { RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride, AircraftProfileDocType } from '../db/index'
import css from './PreflightWarnings.module.css'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// ---------------------------------------------------------------------------
// Module-level GeoJSON cache (loaded once, same pattern as VirtualRadar)
// ---------------------------------------------------------------------------

let _airspaceGeo: GeoJSON.FeatureCollection | null = null
let _obstacleGeo: GeoJSON.FeatureCollection | null = null

function loadGeoJson() {
  if (!_airspaceGeo) {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson'))
      .then((r) => r.json())
      .then((d) => { _airspaceGeo = d })
      .catch(() => { /* offline */ })
  }
  if (!_obstacleGeo) {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-obstacles.geojson'))
      .then((r) => r.json())
      .then((d) => { _obstacleGeo = d })
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
): PreflightWarning[] {
  const warnings: PreflightWarning[] = []

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
  for (const band of profile.airspaceBands) {
    const isDangerous =
      CONTROLLED_CLASSES.has(band.class) || RESTRICTED_CLASSES.has(band.class)
    if (!isDangerous) continue

    // Sample planned altitude at the midpoint of the airspace crossing
    const midNm    = (band.entryNm + band.exitNm) / 2
    const planned  = plannedAltAt(profile, midNm)

    // Flag if planned altitude is INSIDE the vertical extent (flying through)
    if (planned >= band.lower_ft && planned <= band.upper_ft) {
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
        detail: 'Planned altitude on one or more legs falls below terrain + 1,000 ft. Check Virtual Radar.',
      })
    }
  }

  // ── 3. Fuel ─────────────────────────────────────────────────────────────
  if (aircraft && waypoints.length >= 2) {
    const plan = computeFuelPlan(waypoints, legOverrides, aircraft)
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
}

export default function PreflightWarnings({ waypoints, legOverrides, aircraft, aircraftId }: Props) {
  const [airspaceGeo, setAirspaceGeo] = useState<GeoJSON.FeatureCollection | null>(_airspaceGeo)
  const [obstacleGeo, setObstacleGeo] = useState<GeoJSON.FeatureCollection | null>(_obstacleGeo)
  const [msaPts,      setMsaPts]      = useState<MsaPoint[]>([])
  const [terrainDone, setTerrainDone] = useState(false)

  // Prime module-level cache on first mount
  useEffect(() => {
    loadGeoJson()
    // Poll until cache is populated (typically one tick after fetch resolves)
    const id = setInterval(() => {
      if (_airspaceGeo && !airspaceGeo) setAirspaceGeo(_airspaceGeo)
      if (_obstacleGeo && !obstacleGeo) setObstacleGeo(_obstacleGeo)
      if (_airspaceGeo && _obstacleGeo) clearInterval(id)
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
      setMsaPts([])
      setTerrainDone(false)
      return
    }
    setTerrainDone(false)
    const ctrl = new AbortController()
    fetchTerrainProfile(waypoints, '', ctrl.signal)
      .then((pts) => {
        setMsaPts(computeMsaProfile(pts))
        setTerrainDone(true)
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setTerrainDone(true)  // show warnings without MSA rather than hang
        }
      })
    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const profile = useMemo<VirtualRadarProfile | null>(() => {
    if (waypoints.length < 2 || !airspaceGeo || !obstacleGeo) return null
    return buildVirtualRadarProfile(waypoints, legOverrides, airspaceGeo, obstacleGeo)
  }, [waypoints, legOverrides, airspaceGeo, obstacleGeo])

  const warnings = useMemo<PreflightWarning[]>(() => {
    if (!profile) return []
    return computeWarnings(profile, msaPts, aircraft, waypoints, legOverrides, aircraftId)
  }, [profile, msaPts, aircraft, waypoints, legOverrides, aircraftId])

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
