/**
 * Pre-flight route warnings: pure computation shared by the web and native apps.
 *
 * Checks (see docs/architecture.md, "Pre-flight check"):
 *   - airspace penetration by category (classes A-F, restricted, zones, glider/model),
 *     each following the Alert / Info / Ignore setting; surface airspace at the
 *     route's own ends (a CTR/ATZ over departure or arrival) is skipped, except
 *     restricted areas
 *   - restricted areas created by NOTAM (preflightNotams.ts)
 *   - below Minimum Safe Altitude, one warning per leg, with a "raise" fix
 *   - airfield proximity
 *   - fuel
 *   - notices for data that is missing, so "No issues found" never hides a check that did not run
 */

import { DEFAULT_MSA_MARGINS, type MsaMargins } from './msaMargins'
import { terrainAt, getMsaLookup, type VirtualRadarProfile, type MsaPoint, type AirspaceCrossSection, type TerrainPoint } from './virtualRadarCalc'
import { computeTripFuelPlans } from './fuelCalc'
import { crosswindExceedances, thresholdsByIcao, type LandingPoint } from './crosswindCheck'
import { runwayShortfalls, runwaysByIcao, PERF_FACTORS, isPavedSurface, type RunwayPoint } from './runwayPerformance'
import type { ParsedWind } from './fetchWx'
import { collectRoutePois, poiBaseFt } from './routePois'
import { routeNotamAreas, notamSummary } from './preflightNotams'
import { notamTitle } from './notamQCode'
import type { NotamItem } from './fetchNotam'
import { legSpans, legMsaList, legBelowMsa } from './legLevelDrag'
import { airspaceCategory, DEFAULT_AIRSPACE_LEVELS, type AirspaceAlertLevels, type AirspaceCategory } from './airspaceAlertLevel'
import type { RouteWaypoint, LegOverride, AircraftProfileDocType, AssistantReview } from './types'
import type { MefGrid } from './mefGrid'
import { waterStretches } from './waterGlide'

// ---------------------------------------------------------------------------
// Warning types
// ---------------------------------------------------------------------------

/** `info` is an airspace category the pilot set to "info": shown blue, never a problem. */
export type WarningLevel = 'danger' | 'warn' | 'info'

/** A one-tap remedy a warning can offer. */
export type WarningFix = { kind: 'raise-leg'; legIndex: number; altFt: number }

export interface PreflightWarning {
  level:  WarningLevel
  code:   string
  title:  string
  detail: string
  fix?:   WarningFix
  /** Where on the route this applies (NM along it), so a client can show it on the map. */
  focusNm?: number
  /** The leg it concerns, when it is about one. */
  legIndex?: number
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

// ---------------------------------------------------------------------------
// Warning computation
// ---------------------------------------------------------------------------

/** Optional inputs: each check that needs one is skipped without it. */
export interface PreflightExtras {
  terrainPts?:     TerrainPoint[]
  airspaceLevels?: AirspaceAlertLevels
  /** Aerodrome points (GeoJSON) for the airfield proximity check. */
  aerodromes?:     GeoJSON.FeatureCollection | null
  /** Regional NOTAMs for the NOTAM restricted-area check; `airspace` leaves out charted areas. */
  notams?:         readonly NotamItem[]
  airspace?:       GeoJSON.FeatureCollection | null
  nowMs?:          number
  /** Reported surface wind per ICAO (the aerodrome's own METAR), for the crosswind check. */
  surfaceWinds?:   ReadonlyMap<string, ParsedWind>
  /** Reported temperature per ICAO (own METAR), °C, for the runway length check. */
  surfaceTempsC?:  ReadonlyMap<string, number>
  /** Data that could not be loaded: the checks that need it did not run, and the card says so. */
  unavailable?:    PreflightUnavailable
  /** The saved route was written by an AI assistant and not yet saved by the pilot. */
  routeReview?:    AssistantReview | null
  /** Maximum-elevation grids (sea = cells at sea level) and the large lakes (`water`), for the glide-to-land check over water. */
  mefGrids?:       readonly MefGrid[]
  water?:          GeoJSON.FeatureCollection | null
}

/** Checks that did not run. The first three are flags (the card words them itself); `notams` is the
 *  reason shown verbatim, since it differs: signed out, or the service could not be reached. */
export interface PreflightUnavailable {
  airspace?:   boolean
  obstacles?:  boolean
  aerodromes?: boolean
  notams?:     string
}

/** Lateral distance and height above the field inside which a pass is flagged. */
export const PROXIMITY_LATERAL_NM = 1
export const PROXIMITY_ABOVE_FIELD_FT = 1500
/** Aerodromes this close to the route's first or last point are its own ends, not a near miss. */
const PROXIMITY_END_MARGIN_NM = 1

/**
 * Aerodromes the route passes within PROXIMITY_LATERAL_NM of at or below
 * PROXIMITY_ABOVE_FIELD_FT above the field, other than the route's own
 * waypoints and its two ends. Heliports are not flagged.
 */
export interface AirfieldPass {
  label: string
  distNm: number
  lateralNm: number
  plannedFt: number
  elevationFt: number
}

export function airfieldProximity(
  profile: VirtualRadarProfile,
  waypoints: RouteWaypoint[],
  aerodromes: GeoJSON.FeatureCollection,
  terrainPts: TerrainPoint[] = [],
): AirfieldPass[] {
  const out: AirfieldPass[] = []
  const seen = new Set<string>()
  for (const poi of collectRoutePois(waypoints, { aerodromes })) {
    if (poi.kind !== 'aerodrome' || poi.subtype === 'HP' || !poi.label || seen.has(poi.label)) continue
    if (poi.lateralNm > PROXIMITY_LATERAL_NM) continue
    if (poi.distNm < PROXIMITY_END_MARGIN_NM || poi.distNm > profile.totalNm - PROXIMITY_END_MARGIN_NM) continue
    // Unknown field height and no terrain: cannot judge.
    if (poi.elevationFt == null && terrainPts.length === 0) continue
    const elevationFt = poiBaseFt(poi, terrainAt(terrainPts, poi.distNm))
    const plannedFt = plannedAltAt(profile, poi.distNm)
    if (plannedFt > elevationFt + PROXIMITY_ABOVE_FIELD_FT) continue
    seen.add(poi.label)
    out.push({ label: poi.label, distNm: poi.distNm, lateralNm: poi.lateralNm, plannedFt, elevationFt })
  }
  return out
}

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
  extras: PreflightExtras = {},
): PreflightWarning[] {
  const { terrainPts = [], airspaceLevels = DEFAULT_AIRSPACE_LEVELS, aerodromes, notams, airspace, nowMs, unavailable, surfaceWinds, surfaceTempsC, routeReview, mefGrids, water } = extras
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

  // ── Route data that did not load: those checks did not run ──────────────
  if (unavailable?.airspace || unavailable?.obstacles) {
    const what = [unavailable.airspace && 'airspace', unavailable.obstacles && 'obstacles and landmarks'].filter(Boolean).join(' and ')
    warnings.push({
      level:  'warn',
      code:   'route-data-unavailable',
      title:  `Route data unavailable: ${what}`,
      detail: `The ${what} file could not be loaded, so ${unavailable.airspace ? 'airspace' : ''}${unavailable.airspace && unavailable.obstacles ? ' and ' : ''}${unavailable.obstacles ? 'obstacle clearance' : ''} was not checked. Check the connection or download the area for offline use.`,
    })
  }
  if (unavailable?.aerodromes) {
    warnings.push({ level: 'info', code: 'aerodromes-unavailable', title: 'Aerodrome data unavailable', detail: 'Airfield proximity was not checked.' })
  }
  if (unavailable?.notams) {
    warnings.push({ level: 'info', code: 'notams-unavailable', title: 'NOTAM restricted areas not checked', detail: unavailable.notams })
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

  // ── 0b. Aircraft profile written by an AI assistant, not yet reviewed ───
  if (aircraft?.assistantReview) {
    const r = aircraft.assistantReview
    warnings.push({
      level:  'warn',
      code:   'aircraft-assistant-review',
      title:  'Check the aircraft profile',
      detail: `${r.change === 'created' ? `Added by ${r.by}` : `Changed by ${r.by} (${r.change.join(', ')})`} through the assistant connection. Fuel, speeds and runway checks use these values: compare them with the POH, then open and save the aircraft.`,
    })
  }

  // ── 0c. Route written by an AI assistant, not yet reviewed ──────────────
  if (routeReview) {
    warnings.push({
      level:  'warn',
      code:   'route-assistant-review',
      title:  'Check the route',
      detail: `${routeReview.change === 'created' ? `Made by ${routeReview.by}` : `Changed by ${routeReview.by} (${routeReview.change.join(', ')})`} through the assistant connection. Check every point, level and fuel stop on the map, then save the route.`,
    })
  }

  // ── 0d. Over water beyond gliding distance from land (single engine) ───
  // Needs the grid (sea) or the lakes; a multi-engine aircraft is not checked.
  if ((mefGrids?.length || water) && aircraft?.category !== 'MEP') {
    const stretches = waterStretches({
      waypoints, altAt: d => plannedAltAt(profile, d), grids: mefGrids ?? [], water,
      aircraft: aircraft ? { category: aircraft.category, glideRatio: aircraft.glideRatio, bestGlideKts: aircraft.bestGlideIas || (aircraft.cruiseIas ? aircraft.cruiseIas * 0.7 : undefined) } : null,
      ...(legWinds ? { legWinds } : {}),
    })
    for (const st of stretches) {
      if (st.beyondGlideNm <= 0) continue
      const where = st.sea ? 'the sea' : st.name || 'a lake'
      warnings.push({
        level:  'warn',
        code:   'water-beyond-glide',
        title:  `Beyond gliding distance from land over ${where}`,
        detail: `Up to ${st.maxFromLandNm} NM from land (at NM ${Math.round(st.atNm)}); about ${st.beyondGlideNm} NM of the route is beyond gliding distance. `
          + `From ${st.altFt.toLocaleString('en-US')} ft you glide about ${st.glideRangeNm} NM in still air (glide ratio ${st.glideRatio}:1${st.glideAssumed ? ', assumed: set it in the aircraft profile' : ''})`
          + (st.wind ? `; the planned wind (${String(st.wind.fromDeg).padStart(3, '0')}° at ${st.wind.kts} kt) is included and moves the area you can reach about ${st.driftNm} NM downwind. ` : '. ')
          + `Reaching land from there needs about ${st.neededFt >= 99_999 ? 'more than the aircraft can climb to' : `${st.neededFt.toLocaleString('en-US')} ft`}${st.wind ? ' with that wind' : ''}. `
          + `${st.neededFt <= (aircraft?.serviceCeilingFt || 12_500) ? `Climb to about ${st.neededFt.toLocaleString('en-US')} ft, route` : 'Route'} closer to the shore, or carry life jackets for everyone on board (required for single-engine aircraft beyond gliding distance from land) and plan for ditching.`,
        legIndex: st.legIndex,
        focusNm: st.atNm,
      })
    }
  }

  // ── 1. Airspace penetration ─────────────────────────────────────────────
  // The route can cross one airspace twice (it is one band per crossing): warn once per airspace and vertical extent.
  const penetrationSeen = new Set<string>()
  for (const band of profile.airspaceBands) {
    if (!isCheckedAirspace(band.class, band.type)) continue
    const category = airspaceCategory(band.class, band.type)
    const setting = airspaceLevels[category]
    if (setting === 'ignore') continue
    // A restricted area around the route's end is still a restricted area.
    if (category !== 'restricted' && isEndpointSurfaceAirspace(band, profile.totalNm, terrainPts)) continue

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
        : band.class === 'R' ? 'Restricted / danger area'
        : band.class === 'TRA' ? 'TRA'
        : (band.type || band.class)
      // Equipment the aircraft lacks for this airspace: a hard stop, not a reminder.
      const zone = band.class === 'TMZ' || band.type === 'TMZ' ? 'TMZ' : band.class === 'RMZ' || band.type === 'RMZ' ? 'RMZ' : null
      const controlled = /^[A-D]$/.test(band.class)
      const noXpdr  = aircraft?.transponder === 'none'
      const noRadio = aircraft?.hasRadio === false
      const lacks = zone === 'TMZ' && noXpdr ? 'a transponder'
        : (zone === 'RMZ' || controlled) && noRadio ? 'a radio'
        : null
      if (lacks) {
        warnings.push({
          level:  'danger',
          code:   'airspace-equipment',
          title:  `${classLabel} ${band.name} needs ${lacks}`,
          detail: `Planned altitude ${planned.toLocaleString()} ft enters ${band.lower_ft.toLocaleString()}–${band.upper_ft.toLocaleString()} ft. The aircraft profile has no ${lacks === 'a radio' ? 'radio' : 'transponder'}: route around it, or above or below it.`,
          focusNm: midNm,
        })
        continue
      }
      warnings.push({
        level,
        code:   'airspace-penetration',
        title:  `${classLabel} penetration — ${band.name}`,
        detail: `Planned altitude ${planned.toLocaleString()} ft enters ${band.lower_ft.toLocaleString()}–${band.upper_ft.toLocaleString()} ft`,
        focusNm: midNm,
      })
    }
  }

  // ── 1b. Restricted areas created by NOTAM ───────────────────────────────
  if (notams && notams.length > 0 && waypoints.length >= 2) {
    for (const a of routeNotamAreas({ notams, waypoints, airspace, nowMs })) {
      const planned = plannedAltAt(profile, a.alongNm)
      if (planned < a.lowerFt || planned > a.upperFt) continue
      warnings.push({
        level:  'danger',
        code:   'notam-airspace',
        title:  `${notamTitle(a.notam)} on route`,
        detail: `About ${Math.round(a.alongNm)} NM along the route, planned ${Math.round(planned).toLocaleString('en-US')} ft. ${notamSummary(a.notam)}`,
        focusNm: a.alongNm,
      })
    }
  }

  // ── 2. Below Minimum Safe Altitude, leg by leg ──────────────────────────
  // A leg lying wholly within 5 NM of departure/arrival is skipped (climb-out
  // and approach are normal below MSA). The fix raises the leg to its MSA,
  // rounded up to 100 ft.
  if (msaPts.length > 0 && profile.totalNm > 0) {
    const spans = legSpans(profile.altitudeProfile)
    const legMsa = legMsaList(spans, msaPts, getMsaLookup(msaPts))
    const legName = (i: number) => waypoints[i]?.name || `WP ${i + 1}`
    const clearance = `terrain + ${margins.terrainClearanceFt.toLocaleString('en-US')} ft within ${margins.abeamNm} NM, obstacles + ${margins.obstacleClearanceFt.toLocaleString('en-US')} ft`
    const below = spans
      .map((span, i) => ({ span, msa: legMsa[i]! }))
      .filter(({ span, msa }) => legBelowMsa(span, profile.totalNm, span.altFt, msa))
    for (const { span, msa } of below) {
      const i = span.legIndex
      const required = Math.ceil(msa / 100) * 100
      warnings.push({
        level:  'danger',
        code:   'below-msa',
        title:  `Leg ${legName(i)} → ${legName(i + 1)} below Minimum Safe Altitude`,
        detail: `Planned ${Math.round(span.altFt).toLocaleString('en-US')} ft, minimum safe ${required.toLocaleString('en-US')} ft (${clearance}). Check Virtual Radar.`,
        fix:    { kind: 'raise-leg', legIndex: i, altFt: required },
        focusNm: (span.fromNm + span.toNm) / 2,
        legIndex: i,
      })
    }
  }

  // ── 2b. Airfield proximity ──────────────────────────────────────────────
  if (aerodromes && waypoints.length >= 2) {
    for (const a of airfieldProximity(profile, waypoints, aerodromes, terrainPts)) {
      warnings.push({
        level:  'warn',
        code:   'airfield-proximity',
        title:  `Passes close to ${a.label}`,
        detail: `${a.lateralNm.toFixed(1)} NM from the track at ${Math.round(a.distNm)} NM, planned ${Math.round(a.plannedFt).toLocaleString('en-US')} ft over a field at ${Math.round(a.elevationFt).toLocaleString('en-US')} ft: expect circuit and arriving or departing traffic.`,
        focusNm: a.distNm,
      })
    }
  }

  // ── 3. Fuel ─────────────────────────────────────────────────────────────
  if (aircraft && waypoints.length >= 2) {
    // One check per hop: the route splits at points marked as fuel stops.
    const hops = computeTripFuelPlans(waypoints, legOverrides, aircraft, legWinds)
    for (const { fromIdx, toIdx, plan } of hops) {
      if (plan.availableFuelL <= 0) continue
      const hopLabel = hops.length > 1
        ? ` (${waypoints[fromIdx]?.name || `WP${fromIdx + 1}`} → ${waypoints[toIdx]?.name || `WP${toIdx + 1}`})`
        : ''
      if (plan.totalMinFuelL > plan.availableFuelL) {
        warnings.push({
          level:  'danger',
          code:   'fuel-insufficient',
          title:  `Insufficient fuel${hopLabel}`,
          detail: `Requires ${plan.totalMinFuelL.toFixed(1)} L — available ${plan.availableFuelL.toFixed(1)} L`,
        })
      } else if (plan.totalMinFuelL > plan.availableFuelL * 0.85) {
        warnings.push({
          level:  'warn',
          code:   'fuel-tight',
          title:  `Tight fuel margin${hopLabel}`,
          detail: `Requires ${plan.totalMinFuelL.toFixed(1)} L of ${plan.availableFuelL.toFixed(1)} L available`,
        })
      }
    }
  }

  // ── 4. Crosswind where the route takes off or lands ───────────────────
  // Current reports only (METAR), against the profile's maximum demonstrated crosswind.
  if (aircraft && (aircraft.maxCrosswindKts ?? 0) > 0 && surfaceWinds && aerodromes && waypoints.length >= 2) {
    const points: LandingPoint[] = []
    waypoints.forEach((w, i) => {
      if (!w.name) return
      if (i === 0) points.push({ icao: w.name, role: 'departure' })
      else if (i === waypoints.length - 1) points.push({ icao: w.name, role: 'destination' })
      else if (w.fuelStop) points.push({ icao: w.name, role: 'fuel stop' })
    })
    for (const x of crosswindExceedances(points, surfaceWinds, thresholdsByIcao(aerodromes), aircraft.maxCrosswindKts!)) {
      warnings.push({
        level:  'warn',
        code:   'crosswind',
        title:  `Crosswind at ${x.icao} (${x.role})`,
        detail: `Current wind ${x.windText}: ${x.crosswindKt} kt across runway ${x.runway}, the best runway, above the aircraft's ${x.limitKt} kt maximum demonstrated crosswind. Check the forecast for your arrival time.`,
      })
    }
  }

  // ── 5. Runway length where the route takes off or lands ────────────────
  // The profile's distances over 50 ft, scaled for elevation, temperature
  // (current METAR when known), surface and a safety factor.
  if (aircraft && ((aircraft.takeoffDist50ftM ?? 0) > 0 || (aircraft.landingDist50ftM ?? 0) > 0) && aerodromes && waypoints.length >= 2) {
    const points: RunwayPoint[] = []
    waypoints.forEach((w, i) => {
      if (!w.name) return
      if (i === 0) points.push({ icao: w.name, role: 'departure', ops: ['takeoff'] })
      else if (i === waypoints.length - 1) points.push({ icao: w.name, role: 'destination', ops: ['landing'] })
      else if (w.fuelStop) points.push({ icao: w.name, role: 'fuel stop', ops: ['landing', 'takeoff'] })
    })
    for (const x of runwayShortfalls(aircraft, points, runwaysByIcao(aerodromes), surfaceTempsC)) {
      const what = x.op === 'takeoff' ? 'take-off' : 'landing'
      const safety = x.op === 'takeoff' ? PERF_FACTORS.safetyTakeoff : PERF_FACTORS.safetyLanding
      const rwy = `${x.runway.designator ? `runway ${x.runway.designator}` : 'the longest runway'} (${x.runway.lengthM} m ${isPavedSurface(x.runway.surface) ? 'paved' : (x.runway.surface.toLowerCase() || 'unknown surface')})`
      warnings.push({
        level:  'danger',
        code:   'runway-short',
        title:  `Runway short for ${what} at ${x.icao} (${x.role})`,
        detail: `Needs about ${x.requiredM.toLocaleString('en-US')} m: the aircraft's ${what} distance ${x.op === 'takeoff' ? 'over' : 'from'} 50 ft, scaled for elevation${x.tempC != null ? `, ${x.tempC} °C` : ''}, surface and a ${safety} safety factor. Best is ${rwy}. Check the POH for today's mass and conditions.`,
      })
    }
  }

  // Most serious first (stable within a level, so route order is kept).
  const rank: Record<WarningLevel, number> = { danger: 0, warn: 1, info: 2 }
  return warnings.sort((a, b) => rank[a.level] - rank[b.level])
}

