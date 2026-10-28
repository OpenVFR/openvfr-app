/**
 * Pre-flight route warnings: pure computation shared by the web and native apps.
 *
 * Checks:
 *   1. Airspace penetration — planned altitude enters Class C / D / R / TRA
 *   2. Below Minimum Safe Altitude (outside the 5 NM departure/arrival window)
 *   3. Fuel — minimum fuel exceeds (or nearly exceeds) the aircraft's available fuel
 *   plus data-availability notices (terrain, missing aircraft profile).
 */

import { DEFAULT_MSA_MARGINS, type MsaMargins } from './msaMargins'
import { terrainAt, type VirtualRadarProfile, type MsaPoint, type AirspaceCrossSection, type TerrainPoint } from './virtualRadarCalc'
import { computeFuelPlan } from './fuelCalc'
import { airspaceCategory, DEFAULT_AIRSPACE_LEVELS, type AirspaceAlertLevels, type AirspaceCategory } from './airspaceAlertLevel'
import type { RouteWaypoint, LegOverride, AircraftProfileDocType } from './types'

// ---------------------------------------------------------------------------
// Warning types
// ---------------------------------------------------------------------------

/** `info` is an airspace category the pilot set to "info": shown blue, never a problem. */
export type WarningLevel = 'danger' | 'warn' | 'info'

export interface PreflightWarning {
  level:  WarningLevel
  code:   string
  title:  string
  detail: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESTRICTED_CLASSES = new Set(['R', 'TRA'])
const ZONE_NAMES = ['ATZ', 'RMZ', 'TMZ']
const ACTIVITY_CLASSES = new Set(['GLDR', 'MODEL'])
const RED_CATEGORIES = new Set<AirspaceCategory>(['restricted', 'classA'])

/** Airspace worth checking: ICAO classes A-F, restricted, zones, glider/model. Plain class G / FIR is not. */
function isCheckedAirspace(cls: string, type: string): boolean {
  return /^[A-F]$/.test(cls) || RESTRICTED_CLASSES.has(cls) || ACTIVITY_CLASSES.has(cls)
    || ZONE_NAMES.includes(cls) || ZONE_NAMES.includes(type)
}
const DEFAULT_ALT_FT = 3500
const SUPPRESS_DEP_ARR_NM = 5  // ignore MSA violations within 5 NM of dep/arr

/** Floor within this height of the ground counts as "surface level". */
const SURFACE_FLOOR_FT = 100

/**
 * Airspace the route starts or ends inside, reaching down to the ground
 * (a CTR/ATZ over the departure or arrival aerodrome). The pilot operates
 * there by definition, so listing it on every flight from a controlled
 * aerodrome would be noise. Airspace that only starts higher up (a TMA
 * above the aerodrome) is still checked.
 */
export function isEndpointSurfaceAirspace(
  band: Pick<AirspaceCrossSection, 'lower_ft' | 'lowerAgl' | 'openStart' | 'openEnd' | 'entryNm' | 'exitNm'>,
  totalNm: number,
  terrainPts: TerrainPoint[] = [],
): boolean {
  const atStart = !!band.openStart || band.entryNm <= 0.05
  const atEnd   = !!band.openEnd   || band.exitNm >= totalNm - 0.05
  if (!atStart && !atEnd) return false
  const ground = (d: number) => (terrainPts.length > 0 ? Math.max(0, terrainAt(terrainPts, d)) : 0)
  const floorAtGround = (d: number) => band.lower_ft <= ground(d) + SURFACE_FLOOR_FT
  return (atStart && floorAtGround(0)) || (atEnd && floorAtGround(totalNm))
}

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

export function computeWarnings(
  profile:  VirtualRadarProfile,
  msaPts:   MsaPoint[],
  aircraft: AircraftProfileDocType | undefined,
  waypoints: RouteWaypoint[],
  legOverrides: LegOverride[],
  aircraftId?: string,
  terrainFailed = false,
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[],
  margins: MsaMargins = DEFAULT_MSA_MARGINS,
  terrainPts: TerrainPoint[] = [],
  airspaceLevels: AirspaceAlertLevels = DEFAULT_AIRSPACE_LEVELS,
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

  // ── 0. Aircraft profile referenced by this route is not here ───────────
  // (route.aircraftId set, but no matching aircraft_profiles doc: deleted, or
  // made on another device and never synced, e.g. refused by the server)
  if (aircraftId && !aircraft) {
    warnings.push({
      level:  'warn',
      code:   'aircraft-profile-missing',
      title:  'Aircraft not found',
      detail: 'This route was planned with an aircraft that is not in your account or on this device: it was deleted, or made on another device and never reached the server (that device\'s aircraft list says so). Fuel and weight & balance calculations are unavailable until you pick an aircraft.',
    })
  }

  // ── 1. Airspace penetration ─────────────────────────────────────────────
  // The route can cross one airspace twice (it is one band per crossing): warn once per airspace and vertical extent.
  const penetrationSeen = new Set<string>()
  for (const band of profile.airspaceBands) {
    if (!isCheckedAirspace(band.class, band.type)) continue
    const category = airspaceCategory(band.class, band.type)
    const setting = airspaceLevels[category]
    if (setting === 'ignore') continue
    if (isEndpointSurfaceAirspace(band, profile.totalNm, terrainPts)) continue

    // Sample planned altitude at the midpoint of the airspace crossing
    const midNm    = (band.entryNm + band.exitNm) / 2
    const planned  = plannedAltAt(profile, midNm)

    // Flag if planned altitude is INSIDE the vertical extent (flying through)
    if (planned >= band.lower_ft && planned <= band.upper_ft) {
      const seenKey = `${band.class}|${band.name}|${band.lower_ft}|${band.upper_ft}`
      if (penetrationSeen.has(seenKey)) continue
      penetrationSeen.add(seenKey)
      const level: WarningLevel = setting === 'info' ? 'info' : RED_CATEGORIES.has(category) ? 'danger' : 'warn'
      const classLabel = /^[A-F]$/.test(band.class)
        ? (band.type === 'CTR' ? `Class ${band.class} CTR` : `Class ${band.class}`)
        : (band.type || band.class)
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

