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
import { distanceNm, bearingDeg } from '@open-vfr/shared/routeCalc'
import { iasToTas } from '@open-vfr/shared/airspeed'
import { resolveStationWeather, tafChangeSoon } from '@open-vfr/shared/parseTaf'
import { sunriseSunset } from '@open-vfr/shared/sunCalc'
import { computePrompts } from '@open-vfr/shared/preflightPrompts'
import { distanceToRouteNm } from '@open-vfr/shared/notamRouteFilter'
import type { WindAloft } from '@open-vfr/shared/fetchWind'
import type { AircraftProfileDocType, LegOverride } from '@open-vfr/shared/types'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { computeTripFuelPlans } from '@open-vfr/shared/fuelCalc'
import {
  buildVirtualRadarProfile, EMPTY_FEATURES, applyTerrainToBands, terrainForMsa, computeMsaProfile, legCorridorMsaFt,
  getMsaLookup, terrainAt, distanceAlongRouteNm, type TerrainPoint,
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
  /** Forecast wind at each point's altitude and time (null where unknown). */
  legWinds?: (points: { lat: number; lng: number; altFt: number; at: Date }[]) => Promise<(WindAloft | null)[]>
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
  /** When the aircraft is there (departure time, or estimated landing). */
  atIso: string
  /** The TAF's forecast for that time (null = no TAF or nothing for then). */
  tafAtTime: { wind: string; clouds: string; changeSoon: boolean } | null
  sunriseIso: string | null
  sunsetIso: string | null
}

export interface BriefingEnRouteStation {
  icao: string
  name: string | null
  /** Along the route and off it, NM. */
  alongNm: number
  offNm: number
  metar: string | null
  /** A TAF change (FM/BECMG) is due around the time the aircraft passes. */
  tafChangeSoon: boolean
}

export interface BriefingHop {
  from: string
  to: string
  distanceNm: number
  enrouteMins: number
  minFuelL: number | null
  availableFuelL: number | null
  fuelOk: boolean | null
  departIso: string
  arriveIso: string
}

export interface RouteBriefing {
  generatedAt: string
  route: { points: string[]; distanceNm: number; aircraft: string | null }
  departureIso: string
  arrivalIso: string
  /** Wind used per leg (null = none known, still air). */
  legWinds: ({ dirDeg: number; speedKts: number } | null)[]
  windSource: string
  /** Weather reported along the way (aerodromes near the route with their own METAR). */
  enRoute: BriefingEnRouteStation[]
  /** Things to check that are not warnings (border crossing, flight plan, GAR, missing wind). */
  prompts: { title: string; detail: string }[]
  /** Departure before sunrise or landing after sunset. */
  daylight: string[]
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
/** Ground time assumed at a fuel stop (same as the fuel-stop search). */
const STOP_GROUND_MIN = 30
const HOUR_MS = 3_600_000
const EN_ROUTE_MAX = 6
const EN_ROUTE_NM = 10
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const fmtWind = (w: ParsedWind | null) => !w ? 'wind not given' : w.calm ? 'calm' : `${w.variable || w.dirDeg == null ? 'VRB' : String(w.dirDeg).padStart(3, '0')}/${w.speedKt}${w.gustKt ? `G${w.gustKt}` : ''} kt`
/** Ground speed on a true course with the wind triangle (as the fuel plan). */
function groundSpeed(tas: number, courseDeg: number, w: { dirDeg: number; speedKts: number } | null): number {
  if (!w || w.speedKts <= 0) return Math.max(10, tas)
  const r = ((w.dirDeg - courseDeg) * Math.PI) / 180
  const wca = Math.asin(Math.max(-1, Math.min(1, (w.speedKts * Math.sin(r)) / Math.max(tas, 1))))
  return Math.max(10, tas * Math.cos(wca) - w.speedKts * Math.cos(r))
}
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
    /** Planned off-block time (epoch ms); default now. */
    departureMs?: number
    /** The pilot's global wind setting, used before the forecast like in the app. */
    globalWind?: { dirDeg: number; speedKts: number } | null
  },
  deps: BriefingDeps,
): Promise<RouteBriefing> {
  const { waypoints, legOverrides, nowMs } = input
  const aircraft = input.aircraft ?? undefined
  const limits: string[] = []
  const margins = resolveMsaMargins(input.msaMargins)

  // Slow loads start at once and are awaited where needed.
  const demP: Promise<TerrainPoint[]> = (deps.terrain?.(waypoints) ?? Promise.resolve([])).catch(() => [])
  const gridsP: Promise<MefGrid[]> = (deps.mefGrids?.() ?? Promise.resolve([])).catch(() => [])
  const wxP = new Map<string, Promise<{ metar: string | null; taf: string | null } | null>>()
  const weatherOf = (icao: string) => {
    let p = wxP.get(icao)
    if (!p) { p = deps.weather(icao).catch(() => null); wxP.set(icao, p) }
    return p
  }
  waypoints.forEach((w, i) => { if (isIcao(w.name?.toUpperCase()) && (i === 0 || i === waypoints.length - 1 || w.fuelStop)) void weatherOf(w.name!.toUpperCase()) })

  // ── Wind per leg and times ──────────────────────────────────────────────
  // Same order as the app: leg override, the pilot's global wind, forecast
  // at the leg's midpoint, altitude and the time the aircraft is there.
  const depMs = input.departureMs ?? nowMs
  const nLegs = Math.max(0, waypoints.length - 1)
  const legAlt = (i: number) => legOverrides[i]?.altFt ?? (aircraft?.cruiseAltFt || 3500)
  const legTas = (i: number) => {
    const ias = legOverrides[i]?.speedKts ?? aircraft?.cruiseIas
    return ias && ias > 0 ? iasToTas(ias, legAlt(i)) : 100
  }
  const queries: { lat: number; lng: number; altFt: number; at: Date }[] = []
  {
    let cum = 0
    for (let i = 0; i < nLegs; i++) {
      const a = waypoints[i]!, b = waypoints[i + 1]!
      const m = (distanceNm(a, b) / legTas(i)) * 60
      queries.push({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2, altFt: legAlt(i), at: new Date(depMs + (cum + m / 2) * 60_000) })
      cum += m + (b.fuelStop ? STOP_GROUND_MIN : 0)
    }
  }
  const allOverridden = queries.every((_, i) => legOverrides[i]?.windDir != null && legOverrides[i]?.windSpd != null)
  const forecast = !allOverridden && !input.globalWind && deps.legWinds
    ? await deps.legWinds(queries).catch(() => queries.map(() => null))
    : queries.map(() => null)
  const legWinds: ({ dirDeg: number; speedKts: number } | null)[] = queries.map((_, i) => {
    const o = legOverrides[i]
    if (o?.windDir != null && o?.windSpd != null) return { dirDeg: o.windDir, speedKts: o.windSpd }
    if (input.globalWind) return { dirDeg: input.globalWind.dirDeg, speedKts: input.globalWind.speedKts }
    return forecast[i] ?? null
  })
  const windSource = allOverridden ? 'set on every leg' : input.globalWind ? 'your global wind setting' : legWinds.some(w => w) ? 'forecast at each leg\'s altitude and time' : 'none (still air)'
  // No wind at all: the shared "wind data unavailable" prompt says so.
  if (legWinds.some(w => w) && legWinds.some(w => !w)) limits.push(`No wind for ${legWinds.filter(w => !w).length} of ${nLegs} legs: still air there.`)

  // Time over each point (ground speed with wind; ground time at fuel stops).
  const etaMs: number[] = [depMs]
  for (let i = 0; i < nLegs; i++) {
    const a = waypoints[i]!, b = waypoints[i + 1]!
    const gs = groundSpeed(legTas(i), bearingDeg(a, b), legWinds[i] ?? null)
    etaMs.push(etaMs[i]! + (distanceNm(a, b) / gs) * 3_600_000 + (a.fuelStop && i > 0 ? STOP_GROUND_MIN * 60_000 : 0))
  }

  // ── Route and hops ─────────────────────────────────────────────────────
  let total = 0
  for (let i = 0; i < waypoints.length - 1; i++) total += distanceNm(waypoints[i]!, waypoints[i + 1]!)
  const hopsRaw = aircraft ? computeTripFuelPlans(waypoints, legOverrides, aircraft, legWinds) : null
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
        departIso: new Date(h.fromIdx === 0 ? depMs : etaMs[h.fromIdx]! + STOP_GROUND_MIN * 60_000).toISOString(),
        arriveIso: new Date(etaMs[h.toIdx]!).toISOString(),
      })
    }
  } else {
    limits.push('No aircraft profile on this route: fuel not checked, times assume 100 kt.')
  }
  const arrivalMs = etaMs[etaMs.length - 1] ?? depMs

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
  const daylight: string[] = []
  const stopWx = await Promise.all(stops.map(s => weatherOf(s.icao)))
  for (const [k, s] of stops.entries()) {
    const idx = s.role === 'departure' ? 0 : s.role === 'destination' ? waypoints.length - 1 : waypoints.findIndex(w => w.name?.toUpperCase() === s.icao && w.fuelStop)
    const atMs = idx >= 0 ? etaMs[idx] ?? depMs : depMs
    const wx = stopWx[k] ?? null
    if (wx?.metar) {
      const w = metarSurfaceWind(wx.metar)
      if (w) winds.set(s.icao, w)
      const t = parseMetarTempC(wx.metar)
      if (t != null) temps.set(s.icao, t)
    }
    // NOTAMs in force around the time the aircraft is there (an hour either side).
    const notams = deps.aerodromeNotams(s.icao)
      .filter(n => (!n.expires || Date.parse(n.expires) > atMs - HOUR_MS) && (!n.effective || Date.parse(n.effective) < atMs + HOUR_MS))
      .map(n => ({ id: n.id, title: notamTitle(n), summary: notamSummary(n, 200), effective: n.effective, expires: n.expires }))
    const fc = wx?.taf ? resolveStationWeather({ metarWind: null, metarClouds: null, taf: wx.taf, nowMs: atMs }) : null
    const sun = sunriseSunset(waypoints[Math.max(0, idx)]!.lat, waypoints[Math.max(0, idx)]!.lng, new Date(atMs))
    aerodromes.push({
      icao: s.icao, name: adName.get(s.icao) ?? null, role: s.role, metar: wx?.metar ?? null, taf: wx?.taf ?? null, notams, notamsChecked: notamState.available,
      atIso: new Date(atMs).toISOString(),
      tafAtTime: fc && (fc.wind || fc.clouds.length) ? { wind: fmtWind(fc.wind), clouds: fc.clouds.map(c => `${c.cover}${String(Math.round(c.baseFt / 100)).padStart(3, '0')}${c.type ?? ''}`).join(' ') || 'no cloud given', changeSoon: fc.tafChangeSoon } : null,
      sunriseIso: sun.rise?.toISOString() ?? null, sunsetIso: sun.set?.toISOString() ?? null,
    })
    if (sun.set && s.role !== 'departure' && atMs > sun.set.getTime()) daylight.push(`${s.role === 'destination' ? 'Arrival' : 'Landing'} at ${s.icao} about ${hhmm(atMs)}Z is after sunset (${hhmm(sun.set.getTime())}Z): night VFR rules apply.`)
    if (sun.rise && s.role === 'departure' && atMs < sun.rise.getTime()) daylight.push(`Departure from ${s.icao} at ${hhmm(atMs)}Z is before sunrise (${hhmm(sun.rise.getTime())}Z): night VFR rules apply.`)
  }
  // ── Weather along the way ───────────────────────────────────────────────
  const stopSet = new Set(stops.map(s => s.icao))
  const cands = (aerodromesFc?.features ?? []).flatMap(f => {
    const p = f.properties as Record<string, unknown> | null
    const c = (f.geometry as GeoJSON.Point | null)?.coordinates
    const icao = String(p?.['icao'] ?? '').toUpperCase()
    if (!c || !isIcao(icao) || stopSet.has(icao)) return []
    const pt = { lat: c[1]!, lng: c[0]! }
    const off = distanceToRouteNm(pt, waypoints)
    return off <= EN_ROUTE_NM ? [{ icao, name: String(p?.['name'] ?? '') || null, off, along: distanceAlongRouteNm(waypoints, pt) }] : []
  })
  // Spread along the route: the nearest one in each stretch.
  const bucket = total / EN_ROUTE_MAX
  const picked = new Map<number, (typeof cands)[number]>()
  for (const c of cands) {
    const k = Math.min(EN_ROUTE_MAX - 1, Math.floor(c.along / Math.max(bucket, 1)))
    const cur = picked.get(k)
    if (!cur || c.off < cur.off) picked.set(k, c)
  }
  const enRoute: BriefingEnRouteStation[] = []
  const pickedList = [...picked.values()].sort((x, y) => x.along - y.along)
  const pickedWx = await Promise.all(pickedList.map(c => weatherOf(c.icao)))
  for (const [k, c] of pickedList.entries()) {
    const wx = pickedWx[k] ?? null
    if (!wx?.metar) continue
    // Time abeam: interpolate between the points' times by distance.
    let acc = 0, at = depMs
    for (let i = 0; i < nLegs; i++) {
      const d = distanceNm(waypoints[i]!, waypoints[i + 1]!)
      if (c.along <= acc + d) { at = etaMs[i]! + ((c.along - acc) / Math.max(d, 0.1)) * (etaMs[i + 1]! - etaMs[i]!); break }
      acc += d
    }
    enRoute.push({ icao: c.icao, name: c.name, alongNm: Math.round(c.along), offNm: Math.round(c.off), metar: wx.metar, tafChangeSoon: tafChangeSoon(wx.taf, at) })
  }

  if (stops.some(s => !winds.has(s.icao))) limits.push('Some aerodromes have no current METAR here: their crosswind and temperature were not checked.')

  // ── Shared pre-flight warnings ──────────────────────────────────────────
  const rawProfile = buildVirtualRadarProfile(
    waypoints, legOverrides, airspaceFc ?? EMPTY_FEATURES, obstaclesFc ?? EMPTY_FEATURES,
    undefined, landmarksFc ?? undefined, Infinity, aircraft?.cruiseAltFt || undefined,
    { obstacleNm: margins.abeamNm, landmarkNm: margins.abeamNm },
  )

  // ── Terrain and MSA, as the app computes them ───────────────────────────
  const demPts = await demP
  const grids = await gridsP
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
    terrain: msaTerrain.pts,
    corridorFt: msaTerrain.corridorFt,
    margins,
    // Same order as obstacleTipsForMsa: obstacles, then landmarks.
    tips: tips.map((t, k) => {
      const o = profile.obstacles[k]
      const l = o ? undefined : profile.landmarks[k - profile.obstacles.length]
      return { distNm: t.distNm, tipFt: t.elevationFt, estimated: t.estimated, kind: o?.kind ?? l?.kind ?? 'obstacle', name: o?.name ?? l?.name ?? '', ...(o ? { lateralNm: o.lateralNm } : {}) }
    }),
  })

  const warnings = computeWarnings(
    profile, msaPts, aircraft, waypoints, legOverrides, undefined, terrainSource !== 'dem', legWinds, margins,
    {
      terrainPts: demPts, airspaceLevels: input.airspaceLevels,
      // Restricted areas created by NOTAM: those active at departure time.
      aerodromes: aerodromesFc, notams: deps.regionalNotams(), airspace: airspaceFc, nowMs: depMs,
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
    departureIso: new Date(depMs).toISOString(),
    arrivalIso: new Date(arrivalMs).toISOString(),
    legWinds,
    windSource,
    hops,
    aerodromes,
    enRoute,
    warnings,
    prompts: computePrompts({ waypoints, legWinds, windsLoading: false }).map(p => ({ title: p.title, detail: p.detail })),
    daylight,
    legs,
    terrainSource,
    limits,
    disclaimer: BRIEFING_DISCLAIMER,
  }
}

/** A short plain-text rendering, most serious first, for spoken or chat answers. */
export function briefingText(b: RouteBriefing): string {
  const lines: string[] = []
  const t = (iso: string) => `${iso.slice(11, 16)}Z`
  const day = (iso: string) => iso.slice(0, 10)
  lines.push(`Route ${b.route.points.join(' → ')}, ${b.route.distanceNm} NM${b.route.aircraft ? `, aircraft ${b.route.aircraft}` : ''}.`)
  lines.push(`Departure ${day(b.departureIso)} ${t(b.departureIso)}, arrival about ${t(b.arrivalIso)}. Wind: ${b.windSource}${b.legWinds.some(w => w) ? ` (${b.legWinds.map((w, i) => `leg ${i + 1} ${w ? `${String(w.dirDeg).padStart(3, '0')}/${w.speedKts} kt` : 'none'}`).join(', ')})` : ''}.`)
  for (const h of b.hops) {
    const fuel = h.fuelOk == null ? '' : h.fuelOk ? `, fuel OK (${h.minFuelL} of ${h.availableFuelL} L)` : `, NOT ENOUGH FUEL (${h.minFuelL} of ${h.availableFuelL} L)`
    lines.push(`${h.from} → ${h.to}: ${h.distanceNm} NM, about ${h.enrouteMins} min (${t(h.departIso)}-${t(h.arriveIso)})${fuel}.`)
  }
  for (const d of b.daylight) lines.push(`DAYLIGHT: ${d}`)
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
    const fc = (a.tafAtTime ? `; TAF for ${t(a.atIso)}: ${a.tafAtTime.wind}, ${a.tafAtTime.clouds}${a.tafAtTime.changeSoon ? ', CHANGE DUE around then' : ''}` : '')
      + (a.taf && a.role !== 'departure' ? `; TAF ${quote(a.taf, 600)}` : a.taf ? '' : '; no TAF')
    const sun = a.role !== 'departure' && a.sunsetIso ? `; sunset ${t(a.sunsetIso)}` : ''
    lines.push(`${a.role} ${a.icao}${a.name ? ` ${quote(a.name, 80)}` : ''} at ${t(a.atIso)}: METAR ${a.metar ? quote(a.metar, 300) : 'not available'}${fc}${sun}${notams}.`)
  }
  if (b.enRoute.length) {
    lines.push('Weather along the way:')
    for (const e of b.enRoute) lines.push(`- ${e.icao}${e.name ? ` ${quote(e.name, 60)}` : ''} (NM ${e.alongNm}, ${e.offNm} NM off): ${e.metar ? quote(e.metar, 300) : 'no METAR'}${e.tafChangeSoon ? '; TAF change due around then' : ''}`)
  }
  for (const p of b.prompts) lines.push(`Also check: ${p.title}. ${p.detail}`)
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
  const cause = l.msaCause ? ` (set by ${l.msaCause})` : ''
  return `- Leg ${l.leg} ${n(l.from)} → ${n(l.to)}, MT ${String(l.magneticTrackDeg).padStart(3, '0')}°, ${l.lengthNm} NM: planned ${l.plannedFt.toLocaleString('en-US')} ft, ${msa}${cause}${ctl}.${issues} Suggested: ${l.advice.text}`
}
