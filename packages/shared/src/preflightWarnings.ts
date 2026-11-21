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
import { routeNotamAreas } from './preflightNotams'
import type { NotamItem } from './fetchNotam'
import { legSpans, legMsaList, legBelowMsa } from './legLevelDrag'
import { airspaceCategory, DEFAULT_AIRSPACE_LEVELS, type AirspaceAlertLevels, type AirspaceCategory } from './airspaceAlertLevel'
import { type RouteWaypoint, type LegOverride, type AircraftProfileDocType, type AssistantReview } from './types'
import { landingPoints } from './routeCalc'
import { hasVhfRadio } from './icaoFlightPlan'
import type { MefGrid } from './mefGrid'
import { waterStretches } from './waterGlide'
import { formatPreflightWarning, type PreflightWarningItem } from './preflightWarningText'

export { formatPreflightWarning } from './preflightWarningText'
export type { PreflightWarningItem, WarningCode, WarningParamsByCode } from './preflightWarningText'

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
  /** What the title and detail were made from (`formatPreflightWarning`): a client can word the warning itself. */
  params?: PreflightWarningItem['params']
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
  /** Maximum-elevation grids (no-data cells inside a grid = open sea) and the large lakes, for the glide-to-land check over water. */
  mefGrids?:       readonly MefGrid[]
  lakes?:          GeoJSON.FeatureCollection | null
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
  const { terrainPts = [], airspaceLevels = DEFAULT_AIRSPACE_LEVELS, aerodromes, notams, airspace, nowMs, unavailable, surfaceWinds, surfaceTempsC, routeReview, mefGrids, lakes } = extras
  const warnings: PreflightWarningItem[] = []

  // ── Terrain unavailable: the MSA check below is silently skipped and AGL
  // airspace limits are compared at their raw height. Say so rather than
  // let an empty list read as "all clear".
  if (terrainFailed) {
    warnings.push({ level: 'warn', code: 'terrain-unavailable', params: { hasMsa: msaPts.length > 0 } })
  }

  // ── Route data that did not load: those checks did not run ──────────────
  if (unavailable?.airspace || unavailable?.obstacles) {
    warnings.push({ level: 'warn', code: 'route-data-unavailable', params: { airspace: !!unavailable.airspace, obstacles: !!unavailable.obstacles } })
  }
  if (unavailable?.aerodromes) {
    warnings.push({ level: 'info', code: 'aerodromes-unavailable', params: {} })
  }
  if (unavailable?.notams) {
    warnings.push({ level: 'info', code: 'notams-unavailable', params: { reason: unavailable.notams } })
  }

  // ── 0. Aircraft profile referenced by this route is not here ───────────
  // (route.aircraftId set, but no matching aircraft_profiles doc: deleted, or
  // made on another device and never synced, e.g. refused by the server)
  if (aircraftId && !aircraft) {
    warnings.push({ level: 'warn', code: 'aircraft-profile-missing', params: {} })
  }

  // ── 0b. Aircraft profile written by an AI assistant, not yet reviewed ───
  if (aircraft?.assistantReview) {
    warnings.push({ level: 'warn', code: 'aircraft-assistant-review', params: { review: aircraft.assistantReview } })
  }

  // ── 0c. Route written by an AI assistant, not yet reviewed ──────────────
  if (routeReview) {
    warnings.push({ level: 'warn', code: 'route-assistant-review', params: { review: routeReview } })
  }

  // ── 0d. Over water beyond gliding distance from land (single engine) ───
  // Needs the grid (sea) or the lakes; a multi-engine aircraft is not checked.
  if ((mefGrids?.length || lakes) && aircraft?.category !== 'MEP') {
    const stretches = waterStretches({
      waypoints, altAt: d => plannedAltAt(profile, d), grids: mefGrids ?? [], lakes,
      aircraft: aircraft ? { category: aircraft.category, glideRatio: aircraft.glideRatio, bestGlideKts: aircraft.bestGlideIas || (aircraft.cruiseIas ? aircraft.cruiseIas * 0.7 : undefined) } : null,
      ...(legWinds ? { legWinds } : {}),
    })
    for (const st of stretches) {
      if (st.beyondGlideNm <= 0) continue
      warnings.push({
        level:  'warn',
        code:   'water-beyond-glide',
        params: {
          sea: !!st.sea, name: st.name || null, maxFromLandNm: st.maxFromLandNm, atNm: st.atNm, beyondGlideNm: st.beyondGlideNm, altFt: st.altFt,
          glideRangeNm: st.glideRangeNm, glideRatio: st.glideRatio, glideAssumed: !!st.glideAssumed,
          windFromDeg: st.wind ? st.wind.fromDeg : null, windKts: st.wind ? st.wind.kts : null, driftNm: st.wind ? st.driftNm : null,
          neededFt: st.neededFt,
          climbToFt: st.neededFt !== null && st.neededFt <= (aircraft?.serviceCeilingFt || 12_500) ? st.neededFt : null,
        },
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
      // Equipment the aircraft lacks for this airspace: a hard stop, not a reminder.
      const zone = band.class === 'TMZ' || band.type === 'TMZ' ? 'TMZ' : band.class === 'RMZ' || band.type === 'RMZ' ? 'RMZ' : null
      const controlled = /^[A-D]$/.test(band.class)
      const noXpdr  = aircraft?.transponder === 'none'
      const noRadio = aircraft ? hasVhfRadio(aircraft) === false : false
      const lacks = zone === 'TMZ' && noXpdr ? 'transponder' as const
        : (zone === 'RMZ' || controlled) && noRadio ? 'radio' as const
        : null
      const params = { bandClass: band.class, bandType: band.type, name: band.name, plannedFt: planned, lowerFt: band.lower_ft, upperFt: band.upper_ft }
      if (lacks) {
        warnings.push({ level: 'danger', code: 'airspace-equipment', params: { ...params, lacks }, focusNm: midNm })
        continue
      }
      warnings.push({ level, code: 'airspace-penetration', params, focusNm: midNm })
    }
  }

  // ── 1b. Restricted areas created by NOTAM ───────────────────────────────
  if (notams && notams.length > 0 && waypoints.length >= 2) {
    for (const a of routeNotamAreas({ notams, waypoints, airspace, nowMs })) {
      const planned = plannedAltAt(profile, a.alongNm)
      if (planned < a.lowerFt || planned > a.upperFt) continue
      warnings.push({ level: 'danger', code: 'notam-airspace', params: { notam: a.notam, alongNm: a.alongNm, plannedFt: planned }, focusNm: a.alongNm })
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
    const below = spans
      .map((span, i) => ({ span, msa: legMsa[i]! }))
      .filter(({ span, msa }) => legBelowMsa(span, profile.totalNm, span.altFt, msa))
    for (const { span, msa } of below) {
      const i = span.legIndex
      const required = Math.ceil(msa / 100) * 100
      warnings.push({
        level:  'danger',
        code:   'below-msa',
        params: { fromName: legName(i), toName: legName(i + 1), plannedFt: span.altFt, requiredFt: required,
                  terrainClearanceFt: margins.terrainClearanceFt, abeamNm: margins.abeamNm, obstacleClearanceFt: margins.obstacleClearanceFt },
        fix:    { kind: 'raise-leg', legIndex: i, altFt: required },
        focusNm: (span.fromNm + span.toNm) / 2,
        legIndex: i,
      })
    }
  }

  // ── 2b. Airfield proximity ──────────────────────────────────────────────
  if (aerodromes && waypoints.length >= 2) {
    for (const a of airfieldProximity(profile, waypoints, aerodromes, terrainPts)) {
      warnings.push({ level: 'warn', code: 'airfield-proximity', params: { label: a.label, lateralNm: a.lateralNm, distNm: a.distNm, plannedFt: a.plannedFt, elevationFt: a.elevationFt }, focusNm: a.distNm })
    }
  }

  // ── 3. Fuel ─────────────────────────────────────────────────────────────
  if (aircraft && waypoints.length >= 2) {
    // One check per hop: the route splits at points marked as fuel stops.
    const hops = computeTripFuelPlans(waypoints, legOverrides, aircraft, legWinds)
    for (const { fromIdx, toIdx, plan } of hops) {
      if (plan.availableFuelL <= 0) continue
      const hop = hops.length > 1
        ? { from: waypoints[fromIdx]?.name || `WP${fromIdx + 1}`, to: waypoints[toIdx]?.name || `WP${toIdx + 1}` }
        : null
      if (plan.totalMinFuelL > plan.availableFuelL) {
        warnings.push({ level: 'danger', code: 'fuel-insufficient', params: { hop, requiredL: plan.totalMinFuelL, availableL: plan.availableFuelL } })
      } else if (plan.totalMinFuelL > plan.availableFuelL * 0.85) {
        warnings.push({ level: 'warn', code: 'fuel-tight', params: { hop, requiredL: plan.totalMinFuelL, availableL: plan.availableFuelL } })
      }
    }
  }

  // ── 4. Crosswind where the route takes off or lands ───────────────────
  // Current reports only (METAR), against the profile's maximum demonstrated crosswind.
  if (aircraft && (aircraft.maxCrosswindKts ?? 0) > 0 && surfaceWinds && aerodromes && waypoints.length >= 2) {
    const points: LandingPoint[] = landingPoints(waypoints).map(p => ({ icao: p.name, role: p.role }))
    for (const x of crosswindExceedances(points, surfaceWinds, thresholdsByIcao(aerodromes), aircraft.maxCrosswindKts!)) {
      warnings.push({ level: 'warn', code: 'crosswind', params: { icao: x.icao, role: x.role, windText: x.windText, crosswindKt: x.crosswindKt, runway: x.runway, limitKt: x.limitKt } })
    }
  }

  // ── 5. Runway length where the route takes off or lands ────────────────
  // The profile's distances over 50 ft, scaled for elevation, temperature
  // (current METAR when known), surface and a safety factor.
  if (aircraft && ((aircraft.takeoffDist50ftM ?? 0) > 0 || (aircraft.landingDist50ftM ?? 0) > 0) && aerodromes && waypoints.length >= 2) {
    const points: RunwayPoint[] = landingPoints(waypoints).map(p => ({
      icao: p.name, role: p.role, ops: p.role === 'departure' ? ['takeoff'] : p.role === 'destination' ? ['landing'] : ['landing', 'takeoff'],
    }))
    for (const x of runwayShortfalls(aircraft, points, runwaysByIcao(aerodromes), surfaceTempsC)) {
      warnings.push({
        level:  'danger',
        code:   'runway-short',
        params: { op: x.op, icao: x.icao, role: x.role, requiredM: x.requiredM, tempC: x.tempC ?? null,
                  safety: x.op === 'takeoff' ? PERF_FACTORS.safetyTakeoff : PERF_FACTORS.safetyLanding,
                  runway: { designator: x.runway.designator || null, lengthM: x.runway.lengthM, surface: x.runway.surface, paved: isPavedSurface(x.runway.surface) } },
      })
    }
  }

  // Most serious first (stable within a level, so route order is kept).
  const rank: Record<WarningLevel, number> = { danger: 0, warn: 1, info: 2 }
  return warnings.sort((a, b) => rank[a.level] - rank[b.level]).map(formatPreflightWarning)
}

