/**
 * Virtual Radar profile engine — shared between web and native.
 *
 * Given a planned route (array of RouteWaypoints) and the full airspace
 * GeoJSON, this module computes everything needed to render the vertical
 * profile chart:
 *
 *   • Cumulative distance ticks along the route
 *   • Per-leg planned altitude bands
 *   • Airspace cross-sections that intersect the route
 *   • Obstacle markers that fall within a configurable lateral corridor
 *
 * ── Static-pressure / barometric-altitude limitation ────────────────────────
 * Airspace vertical boundaries are defined as barometric altitude (FL = over
 * the 1013.25 hPa standard datum, or feet over QNH) — not geometric/GPS
 * altitude. Converting one to the other exactly requires knowing the local
 * offset between pressure altitude and true altitude, which depends on real
 * atmospheric conditions (temperature deviation from ISA, actual QNH) and can
 * only be measured with a real static-pressure sensor (FLARM, ADS-B/GDL90
 * receiver, panel-mount altimeter feed) — not from GPS altitude alone.
 *
 * Some EFB apps refuse to render vertical airspace boundaries without a
 * real static-pressure source, on grounds of precision. This module takes
 * the practical approach used by most consumer EFBs: treat FL boundaries
 * as literal feet (FL100 = 10,000
 * ft) and QNH-referenced boundaries as literal feet AMSL, compared directly
 * against GPS/geometric altitude. This is an approximation (ISA standard
 * atmosphere assumed, no live QNH/temperature correction) with typically a
 * few hundred feet of error, more in non-standard temperature conditions
 * ("from hot to cold, look out below"). It is NOT a substitute for a properly
 * set barometric altimeter — the chart is situational awareness, not
 * airspace-boundary-compliance proof. See docs/architecture.md and
 * AGENTS.md § Static-pressure limitation for the full discussion.
 *
 * Future upgrade path: if/when a real static-pressure feed becomes available
 * (GDL90/FLARM ownship report includes pressure altitude), calibrate a
 * pressure↔geometric-altitude offset from it and apply that offset when
 * converting FL/QNH boundaries, instead of assuming they are already MSL
 * feet.
 */

import along from '@turf/along'
import length from '@turf/length'
import booleanIntersects from '@turf/boolean-intersects'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import lineIntersect from '@turf/line-intersect'
import nearestPointOnLine from '@turf/nearest-point-on-line'
import {
  lineString,
  point,
} from '@turf/helpers'
import type { Feature, Geometry, Polygon, MultiPolygon } from 'geojson'
import type { RouteWaypoint, LegOverride } from './types'
import { AIRSPACE_COLORS } from './airspaceColors'
import { fetchWithRetry } from './fetchWithRetry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfilePoint = {
  distNm: number   // cumulative distance from departure
  altFt:  number   // planned altitude at this point (cruise level for the leg)
}

/** A "band" of airspace that crosses the route, for rendering as a floating band. */
export type AirspaceCrossSection = {
  class:    string   // 'C' | 'D' | 'E' | 'G' | 'R' | 'TRA' | 'GLDR' | 'MODEL'
  type:     string   // raw OFMX codeType (CTR, TMA, D, R…)
  name:     string
  lower_ft: number
  upper_ft: number
  entryNm:  number   // distance along route where airspace starts
  exitNm:   number   // distance along route where airspace ends
  fill:     string   // colour for the band fill
  border:   string   // colour for the band border
}

/** A stretch of the route that crosses a water polygon (lake/reservoir). */
export type WaterCrossing = {
  entryNm: number   // distance along route where the water crossing starts
  exitNm:  number   // distance along route where the water crossing ends
  name:    string
}

/** An obstacle marker on the profile floor. */
export type ObstacleMarker = {
  distNm:      number
  elevationFt: number   // tip elevation (AMSL)
  heightM:     number   // AGL height (0 if unknown)
  kind:        string   // 'wind_turbine' | 'tower' | 'chimney' | …
  name:        string
}

/**
 * A visual landmark marker on the profile floor (church, mast, windmill,
 * water tower…). OSM/Overpass landmark data (`se-landmarks.geojson`) carries
 * no elevation/height fields, unlike OpenAIP obstacles — elevationFt/heightM
 * are always 0 here, so the renderer floors the marker at the sampled
 * terrain elevation for that distance (same fallback obstacle markers use
 * when their own elevation is below terrain).
 */
export type LandmarkMarker = {
  distNm: number
  kind:   string   // 'church' | 'mast' | 'windmill' | 'water_tower' | 'chimney' | …
  name:   string
}

/** A sampled terrain elevation point along the route. */
export type TerrainPoint = {
  distNm: number
  elevFt: number
}

/** Waypoint tick on the X axis. */
export type WaypointTick = {
  distNm: number
  name:   string
}

/**
 * Minimum Safe Altitude at a point along the route.
 * = highest terrain within the corridor half-width either side + 1,000 ft clearance.
 */
export type MsaPoint = {
  distNm: number
  msaFt:  number
}

export type VirtualRadarProfile = {
  /** Total route length in NM. */
  totalNm: number
  /** Altitude breakpoints forming the planned cruise profile (step function). */
  altitudeProfile: ProfilePoint[]
  /** Max planned altitude across all legs (for Y-axis scaling). */
  maxPlannedAltFt: number
  /** Airspace cross-sections to render as floating bands. */
  airspaceBands: AirspaceCrossSection[]
  /** Obstacle tick marks along the ground. */
  obstacles: ObstacleMarker[]
  /** Visual landmark tick marks along the ground (churches, masts…). */
  landmarks: LandmarkMarker[]
  /** Water (lake/reservoir) crossings along the route. */
  waterCrossings: WaterCrossing[]
  /** Waypoint labels for the X axis. */
  waypointTicks: WaypointTick[]
}

// ---------------------------------------------------------------------------
// Airspace class → display colours (from the canonical shared palette)
// ---------------------------------------------------------------------------
type ClassColours = { fill: string; border: string }

const AIRSPACE_COLOURS: Record<string, ClassColours> = {
  C_CTR: { fill: AIRSPACE_COLORS.cCtrFill, border: AIRSPACE_COLORS.cCtrBorder },
  C:     { fill: AIRSPACE_COLORS.cTmaFill, border: AIRSPACE_COLORS.cTmaBorder },
  D:     { fill: AIRSPACE_COLORS.dFill,    border: AIRSPACE_COLORS.dBorder },
  E:     { fill: AIRSPACE_COLORS.eFill,    border: AIRSPACE_COLORS.eBorder },
  G:     { fill: AIRSPACE_COLORS.gFill,    border: AIRSPACE_COLORS.gBorder },
  R:     { fill: AIRSPACE_COLORS.rFill,    border: AIRSPACE_COLORS.rBorder },
  TRA:   { fill: AIRSPACE_COLORS.traFill,  border: AIRSPACE_COLORS.traBorder },
  GLDR:  { fill: AIRSPACE_COLORS.gldrFill, border: AIRSPACE_COLORS.gldrBorder },
  MODEL: { fill: AIRSPACE_COLORS.modelFill, border: AIRSPACE_COLORS.modelBorder },
}

function airspaceColours(cls: string, type: string): ClassColours {
  if (cls === 'C' && type === 'CTR') return AIRSPACE_COLOURS.C_CTR
  return AIRSPACE_COLOURS[cls] ?? { fill: 'rgba(128,128,128,0.15)', border: 'rgba(128,128,128,0.6)' }
}

// ---------------------------------------------------------------------------
// Default altitude when no leg override is set (ft AMSL)
// ---------------------------------------------------------------------------
const DEFAULT_ALT_FT = 3500

// ---------------------------------------------------------------------------
// Corridor half-width for obstacle inclusion (NM lateral either side of route)
// ---------------------------------------------------------------------------
const OBSTACLE_CORRIDOR_NM = 1.0

// ---------------------------------------------------------------------------
// GeoJSON feature types for airspace + obstacle data
// ---------------------------------------------------------------------------
interface AirspaceProps {
  class:    string
  type:     string
  name:     string
  upper_ft: number
  lower_ft: number
}

interface ObstacleProps {
  kind:         string
  name:         string
  elevation_ft: number
  height_m:     number
}

interface LandmarkProps {
  kind: string
  name: string
}

// ---------------------------------------------------------------------------
// Main profile builder
// ---------------------------------------------------------------------------

/**
 * Build the full virtual-radar profile for a route.
 *
 * @param waypoints     The planned route waypoints (≥ 2 required)
 * @param legOverrides  Per-leg altitude/speed overrides
 * @param airspaceGeoJson  Raw GeoJSON FeatureCollection loaded from se-airspace.geojson
 * @param obstacleGeoJson  Raw GeoJSON FeatureCollection loaded from se-obstacles.geojson
 * @param waterGeoJson     Raw GeoJSON FeatureCollection loaded from se-water.geojson (optional —
 *                         omitted/undefined simply yields no water crossings, same graceful
 *                         degradation as airspace/obstacles being unavailable offline)
 * @param landmarkGeoJson  Raw GeoJSON FeatureCollection loaded from se-landmarks.geojson
 *                         (optional — omitted/undefined simply yields no landmark markers,
 *                         same graceful degradation as the other optional layers)
 */
export function buildVirtualRadarProfile(
  waypoints:       RouteWaypoint[],
  legOverrides:    LegOverride[],
  airspaceGeoJson: GeoJSON.FeatureCollection,
  obstacleGeoJson: GeoJSON.FeatureCollection,
  waterGeoJson?:   GeoJSON.FeatureCollection,
  landmarkGeoJson?: GeoJSON.FeatureCollection,
): VirtualRadarProfile {
  if (waypoints.length < 2) {
    return {
      totalNm: 0,
      altitudeProfile: [],
      maxPlannedAltFt: DEFAULT_ALT_FT,
      airspaceBands: [],
      obstacles: [],
      landmarks: [],
      waterCrossings: [],
      waypointTicks: [],
    }
  }

  // ── 1. Build the route LineString ──────────────────────────────────────────
  const coords = waypoints.map((w) => [w.lng, w.lat] as [number, number])
  const routeLine = lineString(coords)

  // Turf length() uses kilometres by default.
  const totalKm = length(routeLine, { units: 'kilometers' })
  const totalNm = totalKm * 0.539957

  // ── 2. Cumulative distance to each waypoint ────────────────────────────────
  const legDistancesNm: number[] = []
  let cumNm = 0
  for (let i = 0; i < waypoints.length - 1; i++) {
    const segLine = lineString([[waypoints[i].lng, waypoints[i].lat], [waypoints[i + 1].lng, waypoints[i + 1].lat]])
    const legNm = length(segLine, { units: 'kilometers' }) * 0.539957
    legDistancesNm.push(legNm)
    cumNm += legNm
  }

  // Waypoint ticks
  const waypointTicks: WaypointTick[] = []
  let cumTick = 0
  for (let i = 0; i < waypoints.length; i++) {
    waypointTicks.push({
      distNm: Math.round(cumTick * 10) / 10,
      name: waypoints[i].name ?? `WP${i + 1}`,
    })
    if (i < legDistancesNm.length) cumTick += legDistancesNm[i]
  }

  // ── 3. Altitude profile (step function: altitude held across each leg) ─────
  // We emit two points per leg boundary so the chart draws sharp vertical steps.
  const altitudeProfile: ProfilePoint[] = []
  let distCursor = 0

  for (let i = 0; i < waypoints.length - 1; i++) {
    const override = legOverrides[i] ?? {}
    const altFt = override.altFt ?? DEFAULT_ALT_FT
    const legNm = legDistancesNm[i]
    // Start of this leg
    altitudeProfile.push({ distNm: Math.round(distCursor * 100) / 100, altFt })
    distCursor += legNm
    // End of this leg (same altitude — next iteration will push the new level
    // at this same distNm creating the vertical step)
    altitudeProfile.push({ distNm: Math.round(distCursor * 100) / 100, altFt })
  }

  const maxPlannedAltFt = altitudeProfile.reduce((m, p) => Math.max(m, p.altFt), 0)

  // ── 4. Airspace cross-sections ─────────────────────────────────────────────
  // Entry/exit distance-along-route for each intersecting airspace polygon is
  // found from the actual route/boundary CROSSING points (line-intersect
  // between the route line and the polygon outline), not by projecting each
  // polygon vertex onto the route and taking min/max — that older approach
  // used whichever vertex happened to be geometrically nearest to some point
  // on the route, which for a circular/curved boundary (most CTRs) can be a
  // vertex on the FAR side of the circle, making the computed entry distance
  // far too short (e.g. chart shows "inside CTR" while the aircraft is still
  // ~1 NM outside on the map).
  const airspaceBands: AirspaceCrossSection[] = []

  for (const feature of airspaceGeoJson.features) {
    const geom = feature.geometry as Geometry
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue
    if (!booleanIntersects(routeLine, feature as Feature)) continue

    const p = feature.properties as AirspaceProps
    if (!p) continue

    const lowerFt = Number(p.lower_ft ?? 0)
    const upperFt = Number(p.upper_ft ?? 0)
    if (upperFt <= 0) continue

    // Distances (NM along the route) of every point where the route crosses
    // the polygon's boundary.
    const crossingDistsNm: number[] = []
    const boundaryHit = lineIntersect(routeLine, feature as Feature<Polygon | MultiPolygon>)
    for (const hit of boundaryHit.features) {
      const snapped = nearestPointOnLine(routeLine, hit, { units: 'kilometers' })
      crossingDistsNm.push((snapped.properties.location ?? 0) * 0.539957)
    }

    // Route endpoints that are themselves inside the polygon (route starts
    // and/or ends inside the airspace — no boundary crossing on that side).
    const startInside = booleanPointInPolygon(coords[0], feature as Feature<Polygon | MultiPolygon>)
    const endInside   = booleanPointInPolygon(coords[coords.length - 1], feature as Feature<Polygon | MultiPolygon>)

    let minDistNm = crossingDistsNm.length > 0 ? Math.min(...crossingDistsNm) : Infinity
    let maxDistNm = crossingDistsNm.length > 0 ? Math.max(...crossingDistsNm) : -Infinity
    if (startInside) minDistNm = 0
    if (endInside)   maxDistNm = totalNm

    // Degenerate case: route only grazes the boundary (tangent, no proper
    // crossing) with neither endpoint inside — fall back to the old
    // vertex-projection min/max so the band doesn't just disappear.
    if (!Number.isFinite(minDistNm) || !Number.isFinite(maxDistNm)) {
      const extractCoords = (g: Geometry): [number, number][] => {
        if (g.type === 'Polygon') return (g.coordinates as [number, number][][]).flat()
        if (g.type === 'MultiPolygon') return (g.coordinates as [number, number][][][]).flat(2)
        return []
      }
      minDistNm = Infinity
      maxDistNm = -Infinity
      for (const coord of extractCoords(geom)) {
        const pt = point(coord)
        const snapped = nearestPointOnLine(routeLine, pt, { units: 'kilometers' })
        const distNm = (snapped.properties.location ?? 0) * 0.539957
        if (distNm < minDistNm) minDistNm = distNm
        if (distNm > maxDistNm) maxDistNm = distNm
      }
    }

    // Clamp to route bounds
    minDistNm = Math.max(0, minDistNm)
    maxDistNm = Math.min(totalNm, maxDistNm)
    if (maxDistNm <= minDistNm) continue

    const colours = airspaceColours(String(p.class ?? ''), String(p.type ?? ''))

    airspaceBands.push({
      class:    String(p.class    ?? ''),
      type:     String(p.type     ?? ''),
      name:     String(p.name     ?? ''),
      lower_ft: lowerFt,
      upper_ft: upperFt,
      entryNm:  Math.round(minDistNm * 10) / 10,
      exitNm:   Math.round(maxDistNm * 10) / 10,
      fill:     colours.fill,
      border:   colours.border,
    })
  }

  // Sort by lower altitude so closer-to-ground bands render first (painter's order)
  airspaceBands.sort((a, b) => a.lower_ft - b.lower_ft)

  // ── 5. Obstacle markers within lateral corridor ────────────────────────────
  const obstacleMarkers: ObstacleMarker[] = []
  const corridorNmKm = OBSTACLE_CORRIDOR_NM / 0.539957  // NM → km

  for (const feature of obstacleGeoJson.features) {
    if (feature.geometry?.type !== 'Point') continue
    const p = feature.properties as ObstacleProps
    const snapped = nearestPointOnLine(routeLine, feature as Feature<GeoJSON.Point>, { units: 'kilometers' })
    const lateralKm = snapped.properties.dist ?? Infinity
    if (lateralKm > corridorNmKm) continue

    const distNm = (snapped.properties.location ?? 0) * 0.539957
    if (distNm < 0 || distNm > totalNm) continue

    obstacleMarkers.push({
      distNm:      Math.round(distNm * 10) / 10,
      elevationFt: Number(p.elevation_ft ?? 0),
      heightM:     Number(p.height_m     ?? 0),
      kind:        String(p.kind         ?? ''),
      name:        String(p.name         ?? ''),
    })
  }

  // ── 5b. Landmark markers within lateral corridor ───────────────────────────
  // Same corridor-snap technique as obstacles, but landmarks carry no
  // elevation/height fields — the renderer floors them at sampled terrain.
  const landmarkMarkers: LandmarkMarker[] = []

  for (const feature of landmarkGeoJson?.features ?? []) {
    if (feature.geometry?.type !== 'Point') continue
    const p = feature.properties as LandmarkProps
    const snapped = nearestPointOnLine(routeLine, feature as Feature<GeoJSON.Point>, { units: 'kilometers' })
    const lateralKm = snapped.properties.dist ?? Infinity
    if (lateralKm > corridorNmKm) continue

    const distNm = (snapped.properties.location ?? 0) * 0.539957
    if (distNm < 0 || distNm > totalNm) continue

    landmarkMarkers.push({
      distNm: Math.round(distNm * 10) / 10,
      kind:   String(p?.kind ?? ''),
      name:   String(p?.name ?? ''),
    })
  }

  // ── 6. Water (lake/reservoir) crossings ──────────────────────────────
  // Same entry/exit-by-line-crossing technique as airspace bands above, but
  // no altitude limits to track — just the along-route span so the chart can
  // paint a blue band on the ground baseline there.
  const waterCrossings: WaterCrossing[] = []

  for (const feature of waterGeoJson?.features ?? []) {
    const geom = feature.geometry as Geometry
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue
    if (!booleanIntersects(routeLine, feature as Feature)) continue

    const crossingDistsNm: number[] = []
    const boundaryHit = lineIntersect(routeLine, feature as Feature<Polygon | MultiPolygon>)
    for (const hit of boundaryHit.features) {
      const snapped = nearestPointOnLine(routeLine, hit, { units: 'kilometers' })
      crossingDistsNm.push((snapped.properties.location ?? 0) * 0.539957)
    }

    const startInside = booleanPointInPolygon(coords[0], feature as Feature<Polygon | MultiPolygon>)
    const endInside   = booleanPointInPolygon(coords[coords.length - 1], feature as Feature<Polygon | MultiPolygon>)

    let minDistNm = crossingDistsNm.length > 0 ? Math.min(...crossingDistsNm) : Infinity
    let maxDistNm = crossingDistsNm.length > 0 ? Math.max(...crossingDistsNm) : -Infinity
    if (startInside) minDistNm = 0
    if (endInside)   maxDistNm = totalNm
    if (!Number.isFinite(minDistNm) || !Number.isFinite(maxDistNm)) continue  // tangent graze, no clear span — skip rather than guess

    minDistNm = Math.max(0, minDistNm)
    maxDistNm = Math.min(totalNm, maxDistNm)
    if (maxDistNm <= minDistNm) continue

    const p = feature.properties as { name?: string } | null
    waterCrossings.push({
      entryNm: Math.round(minDistNm * 10) / 10,
      exitNm:  Math.round(maxDistNm * 10) / 10,
      name:    String(p?.name ?? ''),
    })
  }

  waterCrossings.sort((a, b) => a.entryNm - b.entryNm)

  return {
    totalNm,
    altitudeProfile,
    maxPlannedAltFt,
    airspaceBands,
    obstacles: obstacleMarkers,
    landmarks: landmarkMarkers,
    waterCrossings,
    waypointTicks,
  }
}

// ---------------------------------------------------------------------------
// Aircraft performance model — projected flight path
// ---------------------------------------------------------------------------

export type AircraftPerfModel = {
  rocSlFpm:         number  // rate of climb at sea level, fpm
  rocCeilingFpm:    number  // rate of climb at service ceiling, fpm (minimum)
  serviceCeilingFt: number  // service ceiling, ft AMSL
  climbIas:         number  // climb indicated airspeed, kts
  descentFpm:       number  // descent rate, fpm (positive)
  descentIas:       number  // descent indicated airspeed, kts
}

/** Rate of climb at a given altitude using the linear ICAO model. */
function rocAtAlt(alt: number, perf: AircraftPerfModel): number {
  if (perf.rocSlFpm <= 0 || perf.serviceCeilingFt <= 0) return 300
  const frac   = Math.min(1, Math.max(0, alt / perf.serviceCeilingFt))
  const minRoc = perf.rocCeilingFpm > 0 ? perf.rocCeilingFpm : 50
  return Math.max(minRoc, perf.rocSlFpm * (1 - frac))
}

/** Horizontal distance (NM) to climb from fromFt to toFt. */
function climbDistNm(fromFt: number, toFt: number, perf: AircraftPerfModel): number {
  if (toFt <= fromFt || perf.climbIas <= 0) return 0
  const avgRoc  = (rocAtAlt(fromFt, perf) + rocAtAlt(toFt, perf)) / 2
  const minutes = (toFt - fromFt) / avgRoc
  return (minutes / 60) * perf.climbIas
}

/** Horizontal distance (NM) to descend from fromFt to toFt. */
function descentDistNm(fromFt: number, toFt: number, perf: AircraftPerfModel): number {
  if (fromFt <= toFt || perf.descentFpm <= 0 || perf.descentIas <= 0) return 0
  const minutes = (fromFt - toFt) / perf.descentFpm
  return (minutes / 60) * perf.descentIas
}

/**
 * Given the planned step-function altitude profile and an aircraft performance
 * model, compute a realistic projected altitude at each sample distance.
 *
 * The algorithm:
 *  • Departure at departureElevFt (defaults to 0 ft); climbs to the first leg's
 *    cruise level as quickly as performance allows.
 *  • Between legs: climbs immediately at the leg start, or descends as late as
 *    possible before the next waypoint.
 *  • Final descent begins as late as possible so the aircraft arrives at
 *    arrivalElevFt (defaults to 0 ft) at the destination.
 */
export function projectFlightPath(
  altitudeProfile:  ProfilePoint[],
  totalNm:          number,
  perf:             AircraftPerfModel,
  sampleDistNm:     number[],
  departureElevFt = 0,
  arrivalElevFt   = 0,
): number[] {
  if (altitudeProfile.length === 0 || sampleDistNm.length === 0) {
    return sampleDistNm.map(() => departureElevFt)
  }

  // Extract leg altitudes and waypoint end-distances from the step profile.
  // Profile pairs: [legStart, legEnd] with same altFt per leg.
  const nLegs = Math.floor(altitudeProfile.length / 2)
  const legAlts:    number[] = []
  const wpEndDists: number[] = []
  for (let i = 0; i < nLegs; i++) {
    legAlts.push(altitudeProfile[i * 2].altFt)
    wpEndDists.push(altitudeProfile[i * 2 + 1].distNm)
  }

  // Build smooth profile vertices using a state machine.
  const verts: ProfilePoint[] = [{ distNm: 0, altFt: departureElevFt }]
  let curAlt  = departureElevFt
  let curDist = 0

  for (let i = 0; i < nLegs; i++) {
    const legEndNm  = wpEndDists[i]
    const targetAlt = legAlts[i]

    if (targetAlt > curAlt) {
      // Climb immediately at the start of the leg (or continuing from before).
      const tocNm = Math.min(curDist + climbDistNm(curAlt, targetAlt, perf), legEndNm)
      verts.push({ distNm: tocNm, altFt: targetAlt })
      curAlt  = targetAlt
      curDist = tocNm
      if (curDist < legEndNm) {
        verts.push({ distNm: legEndNm, altFt: targetAlt })
        curDist = legEndNm
      }
    } else if (targetAlt < curAlt) {
      // Descend as late as possible before the end of the leg.
      const todNm = Math.max(legEndNm - descentDistNm(curAlt, targetAlt, perf), curDist)
      if (todNm > curDist) {
        verts.push({ distNm: todNm, altFt: curAlt })
      }
      verts.push({ distNm: legEndNm, altFt: targetAlt })
      curAlt  = targetAlt
      curDist = legEndNm
    } else {
      // Same altitude — cruise.
      verts.push({ distNm: legEndNm, altFt: targetAlt })
      curDist = legEndNm
    }
  }

  // Final descent to arrivalElevFt at destination.
  // After the leg loop, the last vertex is usually at totalNm (cruise altitude),
  // so we cannot simply append — the TOD falls BEFORE that vertex.
  // Solution: pop verts strictly past todNm, then insert the descent ramp.
  if (curAlt > arrivalElevFt) {
    const descentDist = descentDistNm(curAlt, arrivalElevFt, perf)
    const todNm = totalNm - descentDist

    if (todNm >= totalNm) {
      // Route is too short to complete a full descent — force arrival altitude.
      if (verts[verts.length - 1].distNm < totalNm) {
        verts.push({ distNm: totalNm, altFt: arrivalElevFt })
      } else {
        verts[verts.length - 1].altFt = arrivalElevFt
      }
    } else {
      // Backtrack: remove vertices strictly after the TOD so we can insert
      // a proper cruise → descent ramp.
      while (verts.length > 1 && verts[verts.length - 1].distNm > todNm) {
        verts.pop()
      }
      // Extend cruise to TOD if the last vertex ends before it.
      if (verts[verts.length - 1].distNm < todNm) {
        verts.push({ distNm: todNm, altFt: curAlt })
      }
      // Descend to arrival elevation at the destination.
      verts.push({ distNm: totalNm, altFt: arrivalElevFt })
    }
  } else if (verts[verts.length - 1].distNm < totalNm) {
    verts.push({ distNm: totalNm, altFt: arrivalElevFt })
  }

  // Linear interpolation at each sample distance.
  return sampleDistNm.map((d) => {
    for (let i = 0; i < verts.length - 1; i++) {
      const { distNm: v1, altFt: a1 } = verts[i]
      const { distNm: v2, altFt: a2 } = verts[i + 1]
      if (d >= v1 && d <= v2) {
        if (v2 === v1) return a1
        return Math.round(a1 + ((d - v1) / (v2 - v1)) * (a2 - a1))
      }
    }
    return verts[verts.length - 1].altFt
  })
}

// ---------------------------------------------------------------------------
// Terrain profile (async, OpenTopoData EU-DEM 25 m)
// ---------------------------------------------------------------------------

const TERRAIN_MAX_PTS = 100   // single request; API limit is 100 per call

/**
 * Fetch ground elevations along the route from OpenTopoData (EU-DEM 25 m).
 * Samples up to TERRAIN_MAX_PTS evenly-spaced points → one POST request.
 * Pass an AbortSignal to cancel on route change.
 *
 * @param waypoints route waypoints (≥2 required)
 * @param baseUrl   pass '' for web (relative URL via Vite proxy / nginx same-origin);
 *                  pass TILE_BASE for native (absolute URL to the server's nginx
 *                  proxy at /api/elevation/eudem25m)
 */
export async function fetchTerrainProfile(
  waypoints: RouteWaypoint[],
  baseUrl = '',
  signal?:   AbortSignal,
): Promise<TerrainPoint[]> {
  if (waypoints.length < 2) return []

  const coords    = waypoints.map((w) => [w.lng, w.lat] as [number, number])
  const routeLine = lineString(coords)
  const totalKm   = length(routeLine, { units: 'kilometers' })
  const totalNm   = totalKm * 0.539957

  // Choose sample count so spacing is ~1 NM but capped at TERRAIN_MAX_PTS.
  const n      = Math.min(TERRAIN_MAX_PTS, Math.max(10, Math.ceil(totalNm)))
  const stepKm = totalKm / (n - 1)

  const samples: { distNm: number; lat: number; lng: number }[] = []
  for (let i = 0; i < n; i++) {
    const distKm = Math.min(i * stepKm, totalKm)
    const pt     = along(routeLine, distKm, { units: 'kilometers' })
    samples.push({
      distNm: distKm * 0.539957,
      lng:    pt.geometry.coordinates[0],
      lat:    pt.geometry.coordinates[1],
    })
  }

  const locStr = samples.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join('|')

  // Retries transient network blips / 502-504 -- see fetchWithRetry.ts.
  const resp = await fetchWithRetry(`${baseUrl}/api/elevation/eudem25m`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ locations: locStr }),
    signal,
  })
  if (!resp.ok) throw new Error(`OpenTopoData HTTP ${resp.status}`)

  const data = await resp.json() as {
    results: { elevation: number | null }[]
    status:  string
  }
  if (data.status !== 'OK') throw new Error(`OpenTopoData: ${data.status}`)

  return data.results.map((r, i) => ({
    distNm: Math.round(samples[i].distNm * 100) / 100,
    elevFt: Math.round((r.elevation ?? 0) * 3.28084),
  }))
}

// ---------------------------------------------------------------------------
// MSA computation — Minimum Safe Altitude per terrain sample point
// ---------------------------------------------------------------------------

const MSA_CORRIDOR_NM  = 5.0    // abeam half-width either side of route centreline
const MSA_CLEARANCE_FT = 1000   // obstacle clearance above highest terrain

/**
 * Returns the aircraft's current distance in nautical miles along a planned
 * route by projecting `pos` onto the nearest point of the route polyline.
 * Used to drive the "you are here" marker on the VirtualRadar chart.
 */
export function distanceAlongRouteNm(
  waypoints: RouteWaypoint[],
  pos: { lat: number; lng: number },
): number {
  if (waypoints.length < 2) return 0
  const routeLine = lineString(waypoints.map((w) => [w.lng, w.lat]))
  const snapped = nearestPointOnLine(routeLine, point([pos.lng, pos.lat]), { units: 'kilometers' })
  const km = snapped.properties.location ?? 0
  return km / 1.852 // km → NM
}

/**
 * Perpendicular (lateral) distance in nautical miles from `pos` to the
 * nearest point on the planned route polyline — the cross-track error.
 * Used to flag the VirtualRadar/VerticalProfile chart as showing a route
 * the aircraft is no longer actually on: the chart's terrain/airspace/MSA
 * data is always sampled along the *planned* corridor (see module header),
 * so once the aircraft has meaningfully diverged from that line, what's
 * drawn ahead of the "you are here" marker no longer reflects the terrain
 * the aircraft will actually overfly. Cheap early-warning companion to
 * distanceAlongRouteNm above — a separate turf call rather than folding into
 * that function's return value, so existing call sites (which only need the
 * along-route distance) don't have to change shape.
 */
export function routeCrossTrackNm(
  waypoints: RouteWaypoint[],
  pos: { lat: number; lng: number },
): number {
  if (waypoints.length < 2) return 0
  const routeLine = lineString(waypoints.map((w) => [w.lng, w.lat]))
  const snapped = nearestPointOnLine(routeLine, point([pos.lng, pos.lat]), { units: 'kilometers' })
  const km = snapped.properties.dist ?? 0
  return km / 1.852 // km → NM
}

/**
 * Inverse of distanceAlongRouteNm — given a cumulative NM distance along the
 * route, return the corresponding geographic coordinate.
 * Uses @turf/along which interpolates along the LineString.
 */
export function coordinateAlongRouteNm(
  waypoints: RouteWaypoint[],
  distNm: number,
): { lng: number; lat: number } {
  if (waypoints.length < 2) return { lng: waypoints[0]?.lng ?? 0, lat: waypoints[0]?.lat ?? 0 }
  const routeLine = lineString(waypoints.map((w) => [w.lng, w.lat]))
  const km = distNm * 1.852
  const totalKm = length(routeLine, { units: 'kilometers' })
  // Clamp to route extents
  const clampedKm = Math.max(0, Math.min(km, totalKm))
  const pt = along(routeLine, clampedKm, { units: 'kilometers' })
  const [lng, lat] = pt.geometry.coordinates
  return { lng, lat }
}

/**
 * Compute MSA at each terrain sample point.
 *
 * For each point, scan all other terrain samples within a ±MSA_CORRIDOR_NM
 * window along the route (i.e. the route-distance axis, not lateral distance —
 * this is a conservative simplification appropriate for VFR planning: it
 * effectively checks a "sausage" of terrain either side of the route segment).
 * MSA = max terrain elevation in that window + MSA_CLEARANCE_FT.
 *
 * The corridor is sampled along the route distance axis rather than laterally
 * because we only have elevation data along the centreline.  For a proper
 * lateral scan the user would need a full DEM raster (Phase 2 deferred task).
 * This approach is standard for single-corridor MSA used in VFR planning tools.
 */
export function computeMsaProfile(terrainPts: TerrainPoint[]): MsaPoint[] {
  if (terrainPts.length === 0) return []

  return terrainPts.map((pt, _i) => {
    // Find the sample-index range that falls within ±MSA_CORRIDOR_NM.
    // Since samples are monotonically ordered by distNm we can binary-search,
    // but a simple linear scan is fast enough for ≤100 points.
    let maxElev = 0
    for (let j = 0; j < terrainPts.length; j++) {
      const diff = Math.abs(terrainPts[j].distNm - pt.distNm)
      if (diff > MSA_CORRIDOR_NM) continue
      if (terrainPts[j].elevFt > maxElev) maxElev = terrainPts[j].elevFt
    }

    // Round up to the next 100 ft for a conventional MSA presentation.
    const rawMsa   = maxElev + MSA_CLEARANCE_FT
    const roundedMsa = Math.ceil(rawMsa / 100) * 100

    // Suppress MSA for sea-level terrain (open ocean / flat estuary):
    // terrain ≤ 0 ft → MSA is just the clearance itself, which is meaningless
    // to show so we emit 0 so the chart can filter it out.
    return {
      distNm: pt.distNm,
      msaFt:  maxElev > 0 ? roundedMsa : 0,
    }
  })
}

/**
 * Linearly interpolate ground elevation at an arbitrary distance along the
 * route from the sampled terrain points.
 *
 * Used to floor an obstacle's base elevation before adding its AGL height:
 * obstacles are laterally snapped from up to OBSTACLE_CORRIDOR_NM off the
 * route for corridor inclusion, but plotted using their OWN surveyed ground
 * elevation, which can genuinely be lower than the terrain profile drawn
 * along the route centreline at that x-position (local terrain varies within
 * the corridor). Without this floor an obstacle icon can render
 * behind/below the drawn terrain silhouette. Most obstacles also have
 * height_m: 0 in the source data (AGL height unsurveyed) — in that case this
 * floor IS the rendered tip.
 */
export function terrainAt(terrainPts: TerrainPoint[], distNm: number): number {
  if (terrainPts.length === 0) return 0
  if (distNm <= terrainPts[0].distNm) return terrainPts[0].elevFt
  for (let i = 0; i < terrainPts.length - 1; i++) {
    const a = terrainPts[i], b = terrainPts[i + 1]
    if (distNm >= a.distNm && distNm <= b.distNm) {
      if (b.distNm === a.distNm) return a.elevFt
      const f = (distNm - a.distNm) / (b.distNm - a.distNm)
      return a.elevFt + f * (b.elevFt - a.elevFt)
    }
  }
  return terrainPts[terrainPts.length - 1].elevFt
}

// ---------------------------------------------------------------------------
// Chart domain math shared between native's react-native-svg VerticalProfile
// and web's Recharts VirtualRadar — anything below here operates purely in
// distNm/altFt/msaFt terms, never pixels. Each platform maps the results
// through its own xOf()/yOf() (or Recharts dataKey) to actually draw them;
// that pixel-mapping step is the only part that has to stay per-platform.
// Before this was pulled out here, getMsa() and the trajectory-tick math
// were independently re-implemented, byte-for-byte identical, in both
// apps/native/src/components/VerticalProfile.tsx and
// apps/web/src/components/VirtualRadar.tsx — exactly the kind of drift risk
// (e.g. one platform's MSA corridor logic silently diverging from the
// other's over time) this consolidation exists to prevent.
// ---------------------------------------------------------------------------

/** Returns a distNm -> MSA(ft) step-lookup closure over a precomputed MsaPoint[]
 *  profile (see computeMsaProfile above). */
export function getMsaLookup(msaPts: MsaPoint[]): (distNm: number) => number {
  if (msaPts.length === 0) return () => 0
  return (distNm: number): number => {
    let msa = msaPts[0]?.msaFt ?? 0
    for (const p of msaPts) {
      if (p.distNm <= distNm) msa = p.msaFt
      else break
    }
    return msa
  }
}

export interface TrajectoryTick {
  distNm:  number
  /** Minutes elapsed (at the given ground speed) to reach this tick —
   *  needed for vertical-speed altitude extrapolation, not just x-position. */
  timeMin: number
}

/**
 * Forward trajectory tick distances ("1 min/3 min/N min ahead" or the NM
 * equivalent) ahead of the aircraft's current position — mirrors the map's
 * own on-map trajectory line marks. `timeMode=true` treats `marks` as
 * minutes (converted to distance via currentSpeedKts); `timeMode=false`
 * treats them as NM directly (still returns elapsed time for each, needed
 * by computeVspeedTrajectory below). Ticks beyond `totalNm` are dropped.
 */
export function computeTrajectoryTicks(opts: {
  currentDistNm: number | undefined
  currentSpeedKts: number | undefined
  timeMode: boolean
  marks: number[]
  totalNm: number
}): TrajectoryTick[] {
  const { currentDistNm, currentSpeedKts, timeMode, marks, totalNm } = opts
  if (currentDistNm == null || (currentSpeedKts ?? 0) < 5 || totalNm === 0) return []
  const pairs: TrajectoryTick[] = timeMode
    ? marks.map((min) => ({ distNm: currentDistNm + (min / 60) * currentSpeedKts!, timeMin: min }))
    : marks.map((nm)  => ({ distNm: currentDistNm + nm, timeMin: (nm / currentSpeedKts!) * 60 }))
  return pairs.filter((p) => p.distNm <= totalNm)
}

export interface VspeedTrajectoryPoint {
  distNm: number
  altFt:  number
  /** True if this point's projected altitude is below MSA there (and MSA
   *  data was actually available — msaFt of 0 means "unknown", not "safe"). */
  below: boolean
}

/**
 * Linear vertical-speed trajectory (constant-rate extrapolation from the
 * *current instantaneous* vspeed) through each trajectory tick — SkyDemon's
 * Virtual Radar draws exactly this: "a line denoting vertical trajectory...
 * gives idea of current vertical speed and where ascent/descent leave you".
 * Deliberately not the full performance-model projection (that needs an
 * aircraft profile and models level-offs at cruise altitude — see
 * projectFlightPath below); this one only needs live GPS/baro data and vspeed.
 * Points are flagged `below` MSA the same way the performance-model
 * projection's safe/danger split works, just checked per sparse tick point
 * rather than at dense terrain resolution (these ticks are inherently sparse
 * — typically 3 points — same granularity SkyDemon's own "2/5/10 min" dots use).
 */
export function computeVspeedTrajectory(opts: {
  currentDistNm: number | undefined
  currentAltFt: number | undefined
  currentVSpeedFpm: number | undefined
  ticks: TrajectoryTick[]
  getMsa: (distNm: number) => number
}): { points: VspeedTrajectoryPoint[]; attitude: 'climb' | 'descent' | 'level' } {
  const { currentDistNm, currentAltFt, currentVSpeedFpm, ticks, getMsa } = opts
  const LEVEL_VSPEED_FPM = 100
  const attitude: 'climb' | 'descent' | 'level' =
    currentVSpeedFpm == null ? 'level' :
    currentVSpeedFpm > LEVEL_VSPEED_FPM ? 'climb' :
    currentVSpeedFpm < -LEVEL_VSPEED_FPM ? 'descent' : 'level'
  if (currentDistNm == null || currentAltFt == null || currentVSpeedFpm == null || ticks.length === 0) {
    return { points: [], attitude }
  }
  const raw = [
    { distNm: currentDistNm, altFt: currentAltFt },
    ...ticks.map((t) => ({ distNm: t.distNm, altFt: currentAltFt + currentVSpeedFpm * t.timeMin })),
  ]
  const points = raw.map((p) => {
    const msa = getMsa(p.distNm)
    return { ...p, below: msa > 0 && p.altFt < msa }
  })
  return { points, attitude }
}

export interface WeatherMark<S> {
  station: S
  distNm:  number
}

/**
 * Projects METAR/TAF stations (from useWeatherAlongRoute) onto the route's
 * distance axis via distanceAlongRouteNm, and drops any that land outside
 * [0, totalNm] — useWeatherAlongRoute's BUFFER_NM only limits candidates by
 * *lateral* distance to the route, so a station abeam the departure or
 * destination can still project outside the plotted span. Generic over the
 * station shape `S` (native and web each have their own RouteWeatherStation
 * type with the same lat/lng fields) so this doesn't need to import either
 * platform's hook types.
 */
export function projectWeatherMarks<S extends { lat: number; lng: number }>(
  waypoints: RouteWaypoint[],
  stations: S[],
  totalNm: number,
): WeatherMark<S>[] {
  if (stations.length === 0 || waypoints.length < 2) return []
  return stations
    .map((s) => ({ station: s, distNm: distanceAlongRouteNm(waypoints, { lat: s.lat, lng: s.lng }) }))
    .filter((m) => m.distNm >= 0 && m.distNm <= totalNm)
}
