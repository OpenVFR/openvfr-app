/**
 * Route briefing on the server: the pre-flight picture of a saved route in
 * one answer, built from the same shared code the apps use. It feeds the
 * pilot's own AI assistant (MCP tools) and the REST briefing endpoint.
 *
 * Contents: route and hops (distance, time, fuel per take-off), the
 * aerodromes where the route takes off or lands (departure, fuel stops,
 * destination) with METAR/TAF and their NOTAMs, and the shared pre-flight
 * warnings (airspace, NOTAM restricted areas, fuel, equipment, crosswind,
 * runway length, minimum safe altitude), and per leg the vertical picture
 * (MSA, controlled airspace above it, a suggested altitude). Terrain comes
 * from the deployment's DEM archives, or else the conservative
 * maximum-elevation grid; the pilot's synced MSA margins and airspace alert
 * levels are used when given.
 *
 * Pure apart from the injected data loaders, so it is testable without the
 * network. Times are UTC ISO strings.
 */
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import type { AircraftProfileDocType, LegOverride } from '@open-vfr/shared/types'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { computeTripFuelPlans } from '@open-vfr/shared/fuelCalc'
import {
  buildVirtualRadarProfile, EMPTY_FEATURES, applyTerrainToBands, terrainForMsa, computeMsaProfile, legCorridorMsaFt,
  getMsaLookup, terrainAt, type TerrainPoint,
} from '@open-vfr/shared/virtualRadarCalc'
import { computeWarnings, type PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import { obstacleTipsForMsa } from '@open-vfr/shared/obstacleHeights'
import { legSpans, legMsaList, legMsaApplies } from '@open-vfr/shared/legLevelDrag'
import { legAltitudes, type LegAltitude } from '@open-vfr/shared/legAltitudes'
import { resolveMsaMargins, type MsaMargins } from '@open-vfr/shared/msaMargins'
import type { AirspaceAlertLevels } from '@open-vfr/shared/airspaceAlertLevel'
import type { MefGrid } from '@open-vfr/shared/mefGrid'
import type { ParsedWind } from '@open-vfr/shared/fetchWx'
import { metarSurfaceWind } from '@open-vfr/shared/crosswindCheck'
import { parseMetarTempC } from '@open-vfr/shared/runwayPerformance'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { notamSummary } from '@open-vfr/shared/preflightNotams'
import { quote, QUOTE_NOTE } from './untrusted'

type FC = GeoJSON.FeatureCollection

export interface BriefingDeps {
  /** Aerodromes, airspace, obstacles and landmarks for the route's regions. A failed load returns null. */
  loadDataset: (kind: 'aerodromes' | 'airspace' | 'obstacles' | 'landmarks') => Promise<FC | null>
  /** Terrain samples along the route from a DEM; throws or [] when it does not cover the route. */
  terrain?: (waypoints: RouteWaypoint[]) => Promise<TerrainPoint[]>
  /** Maximum-elevation grids for the route's regions (conservative terrain when the DEM fails). */
  mefGrids?: () => Promise<MefGrid[]>
  /** Regional NOTAMs (restricted areas etc.) for the route's regions. */
  regionalNotams: () => readonly NotamItem[]
  /** NOTAMs filed for one aerodrome. */
  aerodromeNotams: (icao: string) => readonly NotamItem[]
  /** Whether NOTAM data is loaded, and as of when (ISO). */
  notamStatus?: () => { available: boolean; asOf: string | null }
  /** METAR/TAF for one aerodrome, null when not available or not allowed now. */
  weather: (icao: string) => Promise<{ metar: string | null; taf: string | null } | null>
}

export interface BriefingAerodrome {
  icao:   string
  name:   string | null
  role:   'departure' | 'fuel stop' | 'destination'
  metar:  string | null
  taf:    string | null
  notams: { id: string; title: string; summary: string; effective: string | null; expires: string | null }[]
  /** False when NOTAM data was not available: `notams` is then empty but unchecked. */
  notamsChecked: boolean
}

export interface BriefingHop {
  from: string
  to: string
  distanceNm: number
  enrouteMins: number
  minFuelL: number | null
  availableFuelL: number | null
  fuelOk: boolean | null
}

export interface RouteBriefing {
  generatedAt: string
  route: { points: string[]; distanceNm: number; aircraft: string | null }
  hops: BriefingHop[]
  aerodromes: BriefingAerodrome[]
  warnings: { level: PreflightWarning['level']; title: string; detail: string; leg?: number; atNm?: number }[]
  /** Vertical picture and suggested altitude per leg. */
  legs: LegAltitude[]
  /** Where the terrain came from: DEM samples, the maximum-elevation grid only, or none. */
  terrainSource: 'dem' | 'grid' | 'none'
  /** What this briefing could not check, in plain words. */
  limits: string[]
  disclaimer: string
}

export const BRIEFING_DISCLAIMER =
  'Planning aid only, not an official briefing. Check the official AIP, NOTAM and weather sources before flight.'

const pointName = (w: RouteWaypoint, i: number) => w.name || `WP${i + 1}`
/** 1-based leg containing a distance along the route. */
function legAt(spans: readonly { fromNm: number; toNm: number }[], nm: number): number {
  const i = spans.findIndex(s => nm >= s.fromNm - 0.01 && nm <= s.toNm + 0.01)
  return (i < 0 ? spans.length - 1 : i) + 1
}
const isIcao = (s: string | undefined): s is string => !!s && /^[A-Z]{4}$/.test(s)

export async function buildRouteBriefing(
  input: {
    waypoints: RouteWaypoint[]; legOverrides: LegOverride[]; aircraft?: AircraftProfileDocType | null; nowMs: number
    /** The pilot's MSA margins and airspace alert levels (synced settings); defaults when absent. */
    msaMargins?: Partial<MsaMargins> | null
    airspaceLevels?: AirspaceAlertLevels
  },
  deps: BriefingDeps,
): Promise<RouteBriefing> {
  const { waypoints, legOverrides, nowMs } = input
  const aircraft = input.aircraft ?? undefined
  const limits: string[] = []
  const margins = resolveMsaMargins(input.msaMargins)

  // ── Route and hops ─────────────────────────────────────────────────────
  let total = 0
  for (let i = 0; i < waypoints.length - 1; i++) total += distanceNm(waypoints[i]!, waypoints[i + 1]!)
  const hopsRaw = aircraft ? computeTripFuelPlans(waypoints, legOverrides, aircraft) : null
  const hops: BriefingHop[] = []
  if (hopsRaw) {
    for (const h of hopsRaw) {
      let d = 0
      for (let i = h.fromIdx; i < h.toIdx; i++) d += distanceNm(waypoints[i]!, waypoints[i + 1]!)
      const avail = h.plan.availableFuelL > 0 ? h.plan.availableFuelL : null
      hops.push({
        from: pointName(waypoints[h.fromIdx]!, h.fromIdx),
        to: pointName(waypoints[h.toIdx]!, h.toIdx),
        distanceNm: Math.round(d * 10) / 10,
        enrouteMins: Math.round(h.plan.enrouteMins),
        minFuelL: Math.round(h.plan.totalMinFuelL * 10) / 10,
        availableFuelL: avail,
        fuelOk: avail == null ? null : h.plan.totalMinFuelL <= avail,
      })
    }
  } else {
    limits.push('No aircraft profile on this route: no times or fuel.')
  }

  // ── Data ────────────────────────────────────────────────────────────────
  const [aerodromesFc, airspaceFc, obstaclesFc, landmarksFc] = await Promise.all([
    deps.loadDataset('aerodromes'), deps.loadDataset('airspace'), deps.loadDataset('obstacles'), deps.loadDataset('landmarks'),
  ])
  if (!obstaclesFc) limits.push('Obstacle data could not be loaded: the minimum safe altitude covers terrain only.')
  if (!airspaceFc) limits.push('Airspace data could not be loaded: airspace not checked.')
  if (!aerodromesFc) limits.push('Aerodrome data could not be loaded: runways and crosswind not checked.')

  const adName = new Map<string, string>()
  for (const f of aerodromesFc?.features ?? []) {
    const p = f.properties as Record<string, unknown> | null
    const icao = String(p?.['icao'] ?? '').toUpperCase()
    if (icao) adName.set(icao, String(p?.['name'] ?? '') || icao)
  }

  // ── Aerodromes where the route takes off or lands ──────────────────────
  const stops: { icao: string; role: BriefingAerodrome['role'] }[] = []
  waypoints.forEach((w, i) => {
    const name = w.name?.toUpperCase()
    if (!isIcao(name)) return
    if (i === 0) stops.push({ icao: name, role: 'departure' })
    else if (i === waypoints.length - 1) stops.push({ icao: name, role: 'destination' })
    else if (w.fuelStop) stops.push({ icao: name, role: 'fuel stop' })
  })
  const notamState = deps.notamStatus?.() ?? { available: true, asOf: null }
  if (!notamState.available) limits.push('NOTAM data is not available right now: no NOTAMs were checked, not even restricted areas.')
  else if (notamState.asOf && nowMs - Date.parse(notamState.asOf) > 30 * 60_000) limits.push(`NOTAM data is from ${notamState.asOf.slice(0, 16).replace('T', ' ')}Z.`)
  const winds = new Map<string, ParsedWind>()
  const temps = new Map<string, number>()
  const aerodromes: BriefingAerodrome[] = []
  for (const s of stops) {
    const wx = await deps.weather(s.icao).catch(() => null)
    if (wx?.metar) {
      const w = metarSurfaceWind(wx.metar)
      if (w) winds.set(s.icao, w)
      const t = parseMetarTempC(wx.metar)
      if (t != null) temps.set(s.icao, t)
    }
    const notams = deps.aerodromeNotams(s.icao)
      .filter(n => !n.expires || Date.parse(n.expires) > nowMs)
      .map(n => ({ id: n.id, title: notamTitle(n), summary: notamSummary(n, 200), effective: n.effective, expires: n.expires }))
    aerodromes.push({ icao: s.icao, name: adName.get(s.icao) ?? null, role: s.role, metar: wx?.metar ?? null, taf: wx?.taf ?? null, notams, notamsChecked: notamState.available })
  }
  if (stops.some(s => !winds.has(s.icao))) limits.push('Some aerodromes have no current METAR here: their crosswind and temperature were not checked.')

  // ── Shared pre-flight warnings ──────────────────────────────────────────
  const rawProfile = buildVirtualRadarProfile(
    waypoints, legOverrides, airspaceFc ?? EMPTY_FEATURES, obstaclesFc ?? EMPTY_FEATURES,
    undefined, landmarksFc ?? undefined, Infinity, aircraft?.cruiseAltFt || undefined,
    { obstacleNm: margins.abeamNm, landmarkNm: margins.abeamNm },
  )

  // ── Terrain and MSA, as the app computes them ───────────────────────────
  let demPts: TerrainPoint[] = []
  try { demPts = (await deps.terrain?.(waypoints)) ?? [] } catch { demPts = [] }
  const grids = (await deps.mefGrids?.().catch(() => [])) ?? []
  const msaTerrain = terrainForMsa(waypoints, demPts, grids, margins, true)
  const terrainSource: RouteBriefing['terrainSource'] = demPts.length > 0 ? 'dem' : msaTerrain.pts.length > 0 ? 'grid' : 'none'
  // AGL airspace limits are lifted only onto real terrain samples, not the
  // grid (its cell maxima would raise an AGL floor too high).
  const profile = { ...rawProfile, airspaceBands: applyTerrainToBands(rawProfile.airspaceBands, demPts) }
  const tips = obstacleTipsForMsa(profile.obstacles, profile.landmarks, d => terrainAt(msaTerrain.pts, d))
  const msaPts = computeMsaProfile(msaTerrain.pts, margins, tips, msaTerrain.corridorFt)
  const spans = legSpans(profile.altitudeProfile)
  const legMsa = msaPts.length > 0 ? legMsaList(spans, msaPts, getMsaLookup(msaPts), legCorridorMsaFt(waypoints, grids, margins, tips)) : spans.map(() => 0)
  if (terrainSource === 'grid') limits.push('Terrain is from the maximum-elevation grid (highest point per ~460 m cell): the minimum safe altitudes are conservative; limits given above ground are compared at their raw height.')
  if (terrainSource === 'none') limits.push('No terrain data for this route: minimum safe altitude not checked, and limits given above ground are compared at their raw height.')

  const legs = legAltitudes({
    waypoints, spans, bands: profile.airspaceBands, legMsaFt: legMsa, msaPts,
    msaApplies: spans.map(sp => legMsaApplies(sp, profile.totalNm)),
    terrain: demPts.length > 0 ? demPts : msaTerrain.pts,
  })

  const warnings = computeWarnings(
    profile, msaPts, aircraft, waypoints, legOverrides, undefined, terrainSource !== 'dem', undefined, margins,
    {
      terrainPts: demPts, airspaceLevels: input.airspaceLevels,
      aerodromes: aerodromesFc, notams: deps.regionalNotams(), airspace: airspaceFc, nowMs,
      surfaceWinds: winds, surfaceTempsC: temps,
    },
  )
    // The limits above already say what terrain was used.
    .filter(w => w.code !== 'terrain-unavailable')
    .map(w => ({
      level: w.level, title: w.title, detail: w.detail,
      ...(w.legIndex !== undefined ? { leg: w.legIndex + 1 } : w.focusNm !== undefined ? { leg: legAt(spans, w.focusNm) } : {}),
      ...(w.focusNm !== undefined ? { atNm: Math.round(w.focusNm) } : {}),
    }))

  return {
    generatedAt: new Date(nowMs).toISOString(),
    route: {
      points: waypoints.map(pointName),
      distanceNm: Math.round(total * 10) / 10,
      aircraft: aircraft ? (aircraft.registration || aircraft.name) : null,
    },
    hops,
    aerodromes,
    warnings,
    legs,
    terrainSource,
    limits,
    disclaimer: BRIEFING_DISCLAIMER,
  }
}

/** A short plain-text rendering, most serious first, for spoken or chat answers. */
export function briefingText(b: RouteBriefing): string {
  const lines: string[] = []
  lines.push(`Route ${b.route.points.join(' → ')}, ${b.route.distanceNm} NM${b.route.aircraft ? `, aircraft ${b.route.aircraft}` : ''}.`)
  for (const h of b.hops) {
    const fuel = h.fuelOk == null ? '' : h.fuelOk ? `, fuel OK (${h.minFuelL} of ${h.availableFuelL} L)` : `, NOT ENOUGH FUEL (${h.minFuelL} of ${h.availableFuelL} L)`
    lines.push(`${h.from} → ${h.to}: ${h.distanceNm} NM, about ${h.enrouteMins} min${fuel}.`)
  }
  const danger = b.warnings.filter(w => w.level === 'danger')
  const warn = b.warnings.filter(w => w.level === 'warn')
  lines.push(danger.length + warn.length === 0 ? 'No warnings.' : `${danger.length} serious and ${warn.length} other warnings:`)
  // Warning details can carry NOTAM text: quoted like other outside text.
  for (const w of [...danger, ...warn]) lines.push(`- ${w.leg ? `(leg ${w.leg}) ` : ''}${w.title}: ${quote(w.detail, 400)}`)
  if (b.legs.length) {
    lines.push(`Altitude per leg (terrain: ${b.terrainSource === 'dem' ? 'elevation model' : b.terrainSource === 'grid' ? 'maximum-elevation grid, conservative' : 'none'}):`)
    for (const l of b.legs) lines.push(legLine(l))
  }
  for (const a of b.aerodromes) {
    const notams = !a.notamsChecked ? '; NOTAMs not checked'
      : a.notams.length ? `; ${a.notams.length} NOTAM${a.notams.length > 1 ? 's' : ''}: ${a.notams.map(n => `${n.id} ${quote(n.title, 120)}`).join('; ')}`
      : '; no NOTAMs'
    lines.push(`${a.role} ${a.icao}${a.name ? ` ${quote(a.name, 80)}` : ''}: METAR ${a.metar ? quote(a.metar, 300) : 'not available'}${notams}.`)
  }
  for (const l of b.limits) lines.push(`Note: ${l}`)
  lines.push(QUOTE_NOTE)
  lines.push(b.disclaimer)
  return lines.join('\n')
}

/** One leg's vertical picture in a sentence or two. Airspace names come from published data. */
export function legLine(l: LegAltitude): string {
  const msa = l.msaFt > 0 ? `MSA ${l.msaFt.toLocaleString('en-US')} ft${l.msaApplies ? '' : ' (near departure/destination)'}` : 'MSA unknown'
  const ctl = l.controlledFloorFt !== null ? `, controlled airspace from ${l.controlledFloorFt.toLocaleString('en-US')} ft` : ''
  const issues = (l.planned.length ? ` Planned: ${l.planned.join('; ')}.` : '') + (l.notes.length ? ` ${l.notes.join(' ')}` : '')
  const n = (s: string) => (/^[A-Z0-9]{2,5}(\/[A-Z0-9 ]{2,20})?$|^\d+\.\d+[NS] \d+\.\d+[EW]$/.test(s) ? s : quote(s, 40))
  return `- Leg ${l.leg} ${n(l.from)} → ${n(l.to)}, MT ${String(l.magneticTrackDeg).padStart(3, '0')}°, ${l.lengthNm} NM: planned ${l.plannedFt.toLocaleString('en-US')} ft, ${msa}${ctl}.${issues} Suggested: ${l.advice.text}`
}
