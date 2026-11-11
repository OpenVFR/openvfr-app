/**
 * Route briefing on the server: the pre-flight picture of a saved route in
 * one answer, built from the same shared code the apps use. It feeds the
 * pilot's own AI assistant (MCP tools) and the REST briefing endpoint.
 *
 * Contents: route and hops (distance, time, fuel per take-off), the
 * aerodromes where the route takes off or lands (departure, fuel stops,
 * destination) with METAR/TAF and their NOTAMs, and the shared pre-flight
 * warnings (airspace, NOTAM restricted areas, fuel, equipment, crosswind,
 * runway length). Not checked here: terrain / minimum safe altitude, which
 * needs the elevation data the apps load themselves.
 *
 * Pure apart from the injected data loaders, so it is testable without the
 * network. Times are UTC ISO strings.
 */
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import type { AircraftProfileDocType, LegOverride } from '@open-vfr/shared/types'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { computeTripFuelPlans } from '@open-vfr/shared/fuelCalc'
import { buildVirtualRadarProfile, EMPTY_FEATURES } from '@open-vfr/shared/virtualRadarCalc'
import { computeWarnings, type PreflightWarning } from '@open-vfr/shared/preflightWarnings'
import type { ParsedWind } from '@open-vfr/shared/fetchWx'
import { metarSurfaceWind } from '@open-vfr/shared/crosswindCheck'
import { parseMetarTempC } from '@open-vfr/shared/runwayPerformance'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { notamSummary } from '@open-vfr/shared/preflightNotams'

type FC = GeoJSON.FeatureCollection

export interface BriefingDeps {
  /** Aerodromes, airspace and obstacles for the route's regions. A failed load returns null. */
  loadDataset: (kind: 'aerodromes' | 'airspace' | 'obstacles') => Promise<FC | null>
  /** Regional NOTAMs (restricted areas etc.) for the route's regions. */
  regionalNotams: () => readonly NotamItem[]
  /** NOTAMs filed for one aerodrome. */
  aerodromeNotams: (icao: string) => readonly NotamItem[]
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
  warnings: { level: PreflightWarning['level']; title: string; detail: string }[]
  /** What this briefing could not check, in plain words. */
  limits: string[]
  disclaimer: string
}

export const BRIEFING_DISCLAIMER =
  'Planning aid only, not an official briefing. Check the official AIP, NOTAM and weather sources before flight.'

const pointName = (w: RouteWaypoint, i: number) => w.name || `WP${i + 1}`
const isIcao = (s: string | undefined): s is string => !!s && /^[A-Z]{4}$/.test(s)

export async function buildRouteBriefing(
  input: { waypoints: RouteWaypoint[]; legOverrides: LegOverride[]; aircraft?: AircraftProfileDocType | null; nowMs: number },
  deps: BriefingDeps,
): Promise<RouteBriefing> {
  const { waypoints, legOverrides, nowMs } = input
  const aircraft = input.aircraft ?? undefined
  const limits: string[] = ['Terrain and minimum safe altitude are not checked here; open the route in the app.']

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
  const [aerodromesFc, airspaceFc, obstaclesFc] = await Promise.all([
    deps.loadDataset('aerodromes'), deps.loadDataset('airspace'), deps.loadDataset('obstacles'),
  ])
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
    aerodromes.push({ icao: s.icao, name: adName.get(s.icao) ?? null, role: s.role, metar: wx?.metar ?? null, taf: wx?.taf ?? null, notams })
  }
  if (stops.some(s => !winds.has(s.icao))) limits.push('Some aerodromes have no current METAR here: their crosswind and temperature were not checked.')

  // ── Shared pre-flight warnings ──────────────────────────────────────────
  const profile = buildVirtualRadarProfile(
    waypoints, legOverrides, airspaceFc ?? EMPTY_FEATURES, obstaclesFc ?? EMPTY_FEATURES,
    undefined, undefined, Infinity, aircraft?.cruiseAltFt || undefined,
  )
  const warnings = computeWarnings(
    profile, [], aircraft, waypoints, legOverrides, undefined, false, undefined, undefined,
    {
      aerodromes: aerodromesFc, notams: deps.regionalNotams(), airspace: airspaceFc, nowMs,
      surfaceWinds: winds, surfaceTempsC: temps,
    },
  ).map(w => ({ level: w.level, title: w.title, detail: w.detail }))

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
  for (const w of [...danger, ...warn]) lines.push(`- ${w.title}: ${w.detail}`)
  for (const a of b.aerodromes) {
    lines.push(`${a.role} ${a.icao}${a.name ? ` (${a.name})` : ''}: ${a.metar ?? 'no METAR'}${a.notams.length ? `; ${a.notams.length} NOTAM${a.notams.length > 1 ? 's' : ''}: ${a.notams.map(n => n.title).join('; ')}` : '; no NOTAMs'}.`)
  }
  for (const l of b.limits) lines.push(`Note: ${l}`)
  lines.push(b.disclaimer)
  return lines.join('\n')
}
