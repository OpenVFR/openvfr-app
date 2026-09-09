/**
 * Fuel plan calculator.
 *
 * All internal quantities use standard aviation units:
 *   distances  — nautical miles (NM)
 *   altitudes  — feet (ft AMSL)
 *   rates      — fpm (climb/descent) or kts (speed)
 *   fuel       — litres (L)   internal storage matches AircraftProfileDocType
 *   time       — minutes
 *
 * The aircraft profile stores all fuel quantities in litres; callers convert
 * for display as needed.
 */

import { distanceNm, bearingDeg } from './routeCalc'
import type { RouteWaypoint } from './routeCalc'
import type { LegOverride, AircraftProfileDocType } from './types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FuelPlan = {
  /** Fixed taxi/start fuel from aircraft profile. */
  taxiFuelL: number
  /** Fuel burned during all climb phases (aggregate). */
  climbFuelL: number
  /** Fuel burned at cruise power. */
  cruiseFuelL: number
  /** Fuel burned during all descent phases (aggregate). */
  descentFuelL: number
  /** Total enroute fuel = climb + cruise + descent. */
  enrouteFuelL: number
  /** Contingency reserve (% of enroute, from aircraft profile). */
  contingencyFuelL: number
  contingencyPct: number
  /** Holding reserve. */
  holdingFuelL: number
  holdingMin: number
  /** Standard 30-minute diversion reserve at cruise burn. */
  diversionFuelL: number
  /** Fixed landing/alternate reserve from aircraft profile. */
  landingFuelL: number
  /** Grand total minimum required fuel (all items summed). */
  totalMinFuelL: number
  /** Maximum tank capacity from aircraft profile (0 = not set). */
  availableFuelL: number
  /** Total enroute time in minutes (sum of leg times at GS). */
  enrouteMins: number
  /** Total time in climb phases (minutes). */
  climbMins: number
  /** Total time in descent phases (minutes). */
  descentMins: number
  /** Time at cruise power (minutes) = enroute − climb − descent. */
  cruiseMins: number
}

// ---------------------------------------------------------------------------
// Internal performance model
// (mirrors the linear ICAO model used in virtualRadarCalc.ts)
// ---------------------------------------------------------------------------

const DEFAULT_ALT_FT = 3500

/** Rate of climb (fpm) at a given altitude. Returns 0 when perf data absent. */
function rocAtAlt(alt: number, profile: AircraftProfileDocType): number {
  if (profile.rocSlFpm <= 0 || profile.serviceCeilingFt <= 0) return 0
  const frac   = Math.min(1, Math.max(0, alt / profile.serviceCeilingFt))
  const minRoc = profile.rocCeilingFpm > 0 ? profile.rocCeilingFpm : 50
  return Math.max(minRoc, profile.rocSlFpm * (1 - frac))
}

/** Average rate of climb between two altitudes. */
function avgRocBetween(fromFt: number, toFt: number, profile: AircraftProfileDocType): number {
  return (rocAtAlt(fromFt, profile) + rocAtAlt(toFt, profile)) / 2
}

/** True when the profile has the fields needed for climb time calculation. */
function hasClimbPerf(profile: AircraftProfileDocType): boolean {
  return profile.rocSlFpm > 0 && profile.climbIas > 0 && profile.climbFuelLhr > 0
}

/** True when the profile has the fields needed for descent time calculation. */
function hasDescentPerf(profile: AircraftProfileDocType): boolean {
  return profile.descentFpm > 0 && profile.descentFuelLhr > 0
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const EMPTY_PLAN: FuelPlan = {
  taxiFuelL: 0, climbFuelL: 0, cruiseFuelL: 0, descentFuelL: 0,
  enrouteFuelL: 0, contingencyFuelL: 0, contingencyPct: 0,
  holdingFuelL: 0, holdingMin: 0, diversionFuelL: 0, landingFuelL: 0,
  totalMinFuelL: 0, availableFuelL: 0,
  enrouteMins: 0, climbMins: 0, descentMins: 0, cruiseMins: 0,
}

/**
 * Compute the full fuel plan for a planned route given an aircraft profile.
 *
 * The altitude model is identical to the VirtualRadar step-function:
 *   Departure @ 0 ft → climb to leg-1 cruise level → … → descend to 0 ft.
 *
 * Climb and descent times are computed from the aircraft performance model
 * across the entire route (not per-leg), then subtracted from the total
 * enroute time to give cruise time.  This matches the projectFlightPath
 * approach and is appropriate for pre-flight fuel planning.
 *
 * If climb/descent perf data is absent (rocSlFpm = 0 etc.), all enroute
 * time is treated as cruise at `fuelBurnLhr` (simple burn-rate model).
 *
 * Wind corrections use the bearing + wind-correction-angle method consistent
 * with the PLOG ETE calculation in RoutePlan.tsx.
 */
export function computeFuelPlan(
  waypoints:    RouteWaypoint[],
  legOverrides: LegOverride[],
  profile:      AircraftProfileDocType,
): FuelPlan {
  if (waypoints.length < 2) {
    return {
      ...EMPTY_PLAN,
      contingencyPct: profile.contingencyPct,
      holdingMin:     profile.holdingMin,
      availableFuelL: profile.maxFuelL,
    }
  }

  const nLegs = waypoints.length - 1

  // ── 1. Per-leg planned cruise altitudes ────────────────────────────────────
  const legAlts: number[] = Array.from({ length: nLegs }, (_, i) =>
    legOverrides[i]?.altFt ?? (profile.cruiseAltFt || DEFAULT_ALT_FT)
  )

  // Altitude sequence: departure (0 ft) → per-leg cruise levels → arrival (0 ft)
  const altSeq = [0, ...legAlts, 0]

  // ── 2. Total climb / descent time across the full route ────────────────────
  let totalClimbMins   = 0
  let totalDescentMins = 0

  for (let i = 0; i < altSeq.length - 1; i++) {
    const delta = altSeq[i + 1] - altSeq[i]
    if (delta > 0) {
      if (hasClimbPerf(profile)) {
        const avgRoc = avgRocBetween(altSeq[i], altSeq[i + 1], profile)
        if (avgRoc > 0) totalClimbMins += delta / avgRoc
      }
      // If no climb perf data: climb time = 0; treated as cruise burn (conservative)
    } else if (delta < 0) {
      if (hasDescentPerf(profile)) {
        totalDescentMins += Math.abs(delta) / profile.descentFpm
      }
    }
  }

  // ── 3. Total enroute time at ground speed per leg ──────────────────────────
  let totalEnrouteMins = 0
  let hasAnySpeed = false

  for (let i = 0; i < nLegs; i++) {
    const from = waypoints[i]
    const to   = waypoints[i + 1]
    const dist = distanceNm(from, to)
    const ovr  = legOverrides[i] ?? {}
    const ias  = ovr.speedKts ?? profile.cruiseIas

    if (ias <= 0) continue  // no speed data for this leg
    hasAnySpeed = true

    // Ground speed with wind correction (identical to RoutePlan.tsx ETE logic).
    let gs = ias
    if (ovr.windDir != null && ovr.windSpd != null && ovr.windSpd > 0) {
      const brg  = bearingDeg(from, to)
      const wRad = (ovr.windDir * Math.PI) / 180
      const bRad = (brg         * Math.PI) / 180
      const hw   = ovr.windSpd * Math.cos(wRad - bRad)
      const xw   = ovr.windSpd * Math.sin(wRad - bRad)
      const wca  = Math.asin(Math.max(-1, Math.min(1, xw / Math.max(ias, 1))))
      gs = ias * Math.cos(wca) - hw
    }
    gs = Math.max(10, gs) // guard against zero/negative GS

    totalEnrouteMins += (dist / gs) * 60
  }

  // If no leg has speed data, time-based items are zero but fixed items remain.
  if (!hasAnySpeed) {
    return {
      ...EMPTY_PLAN,
      taxiFuelL:      profile.taxiFuelL,
      landingFuelL:   profile.landingFuelL,
      totalMinFuelL:  profile.taxiFuelL + profile.landingFuelL,
      availableFuelL: profile.maxFuelL,
      contingencyPct: profile.contingencyPct,
      holdingMin:     profile.holdingMin,
    }
  }

  // ── 4. Partition enroute time and compute fuel ────────────────────────────
  // Cruise = total − climb − descent (clamped; extreme short legs may have no cruise).
  const cruiseMins = Math.max(0, totalEnrouteMins - totalClimbMins - totalDescentMins)

  // Fuel per phase — fall back to cruise burn if phase-specific data absent.
  const climbFuelL = (totalClimbMins / 60) * (
    hasClimbPerf(profile) ? profile.climbFuelLhr : profile.fuelBurnLhr
  )
  const descentFuelL = (totalDescentMins / 60) * (
    hasDescentPerf(profile) ? profile.descentFuelLhr : profile.fuelBurnLhr
  )
  const cruiseFuelL  = (cruiseMins / 60) * profile.fuelBurnLhr

  const enrouteFuelL     = climbFuelL + cruiseFuelL + descentFuelL
  const contingencyFuelL = enrouteFuelL * (profile.contingencyPct / 100)
  const holdingFuelL     = (profile.holdingMin / 60) * profile.fuelBurnLhr
  const diversionFuelL   = (30 / 60) * profile.fuelBurnLhr  // standard 30-min diversion
  const taxiFuelL        = profile.taxiFuelL
  const landingFuelL     = profile.landingFuelL

  const totalMinFuelL =
    taxiFuelL + enrouteFuelL + contingencyFuelL +
    holdingFuelL + diversionFuelL + landingFuelL

  return {
    taxiFuelL,
    climbFuelL,
    cruiseFuelL,
    descentFuelL,
    enrouteFuelL,
    contingencyFuelL,
    contingencyPct:  profile.contingencyPct,
    holdingFuelL,
    holdingMin:      profile.holdingMin,
    diversionFuelL,
    landingFuelL,
    totalMinFuelL,
    availableFuelL:  profile.maxFuelL,
    enrouteMins:     totalEnrouteMins,
    climbMins:       totalClimbMins,
    descentMins:     totalDescentMins,
    cruiseMins,
  }
}
