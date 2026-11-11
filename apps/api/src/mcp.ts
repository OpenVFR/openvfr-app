/**
 * Read-only MCP endpoint for the pilot's own AI assistant (POST /mcp).
 *
 * The assistant reaches it with an access token from the api's OAuth
 * provider (see ASSISTANT_MCP in auth.ts): `requireMcpAuth` verifies the
 * token (signature, issuer, audience = this endpoint, expiry) and answers
 * 401 with the protected-resource metadata link when it is missing, so the
 * assistant can start sign-in. The token's subject is the user; its scopes
 * decide what the tools may read:
 *
 *   briefing:read   public aviation data and briefings (every token)
 *   routes:read     the user's saved routes and aircraft profiles
 *   routes:write    create and change saved routes (never delete)
 *   aircraft:write  create and change aircraft profiles (never delete)
 *
 * Writes are checked like input in the app, rate-limited, logged and marked
 * for the pilot's review ("check before use") until saved in the app. Answers are short text meant to be read out or
 * summarised, carry the data's age where it has one, link into the app, and
 * end with "not an official briefing" where they brief.
 */
import { requireMcpAuth } from '@better-auth/mcp'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AircraftProfileDocType, RouteDocType } from '@open-vfr/shared/types'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { parseAerodromesGeoJson, type AerodromeFeatureCollectionLike } from '@open-vfr/shared/findDestination'
import { suggestFuelStops, insertFuelStops } from '@open-vfr/shared/fuelStops'
import { FUEL_LABELS, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { metarSurfaceWind, crosswindExceedances, thresholdsByIcao } from '@open-vfr/shared/crosswindCheck'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { briefingText, legLine, BRIEFING_DISCLAIMER } from './briefing'
import { quote, QUOTE_NOTE } from './untrusted'
import { BriefingInputError, type BriefingService, type WeatherFor } from './briefingService'
import { loadCountryDataset } from './briefingData'
import { getAvailableCountries } from './countries'
import { getNotamsForIcao, notamStatus } from './notam'
import { RateLimiter, limitFromEnv } from './rateLimiter'
import { buildAircraft, AircraftInputError, CATEGORIES, NUMERIC_LIMITS, type AircraftInput, type NumericField } from './aircraftTools'
import { buildRoute, legLines, RouteInputError, ALT_LIMITS, SPEED_LIMITS, MAX_POINTS, type RouteInput } from './routeTools'
import { buildPointIndex, resolveRoutePoints, type PointIndex } from '@open-vfr/shared/routeIdentifiers'
import { allPoints, pointsNearPosition, pointsNearLeg, pointsNearAirspaceEdge, type NearPoint, type PointKind } from '@open-vfr/shared/pointsNear'
import type { auth as authInstance } from './auth'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Tool calls per user, on top of the briefing and weather limits the tools also use. */
const mcpLimiter = new RateLimiter([
  { windowMs: HOUR_MS, max: limitFromEnv('MCP_HOURLY_LIMIT', 120) },
  { windowMs: DAY_MS,  max: limitFromEnv('MCP_DAILY_LIMIT', 600) },
])

/** Route and aircraft writes per user: few are ever needed. */
const writeLimiter = new RateLimiter([
  { windowMs: HOUR_MS, max: limitFromEnv('MCP_WRITE_HOURLY_LIMIT', 20) },
  { windowMs: DAY_MS,  max: limitFromEnv('MCP_WRITE_DAILY_LIMIT', 60) },
])

const FIELD_HELP: Partial<Record<NumericField, string>> = {
  cruiseAltFt: 'typical cruise altitude, ft', cruiseIas: 'cruise IAS, kt', fuelBurnLhr: 'cruise fuel burn, L/h',
  maxFuelL: 'USABLE fuel of the standard tanks, L', unusableFuelL: 'unusable fuel, L', taxiFuelL: 'start/taxi/take-off fuel, L',
  landingFuelL: 'fixed fuel to keep at landing, L', holdingMin: 'holding reserve, min', diversionMin: 'diversion reserve, min',
  finalReserveMin: 'final reserve, min', contingencyPct: 'contingency, % of trip fuel',
  serviceCeilingFt: 'service ceiling, ft', rocSlFpm: 'best rate of climb at sea level, ft/min', rocCeilingFpm: 'rate of climb at the service ceiling, ft/min',
  climbIas: 'Vy / climb IAS, kt', climbFuelLhr: 'climb fuel burn at sea level, L/h', climbFuelCeilingLhr: 'climb fuel burn near the ceiling, L/h',
  descentFpm: 'descent rate, ft/min', descentIas: 'descent IAS, kt', descentFuelLhr: 'descent fuel burn, L/h',
  bestGlideIas: 'best glide IAS, kt', glideRatio: 'glide ratio, e.g. 30 for 30:1', takeoffSpeedKts: 'rotation / lift-off speed, kt',
  maxCrosswindKts: 'maximum demonstrated crosswind, kt', takeoffDist50ftM: 'take-off distance over 50 ft, m (max mass, sea level, ISA, paved)',
  landingDist50ftM: 'landing distance from 50 ft, m (same conditions)', vs0Kts: 'Vs0, kt', vs1Kts: 'Vs1, kt', vxKts: 'Vx, kt',
  vfeKts: 'Vfe, kt', vaKts: 'Va, kt', vnoKts: 'Vno, kt', vneKts: 'Vne, kt', minRunwayM: 'shortest runway the pilot accepts, m',
}

/** Input fields shared by create_aircraft and update_aircraft: units are fixed, convert before calling. */
const aircraftFields = {
  name: z.string().max(80).optional().describe('Profile name, e.g. "Cessna 182R"'),
  icaoType: z.string().max(4).optional().describe('ICAO type designator, e.g. C182'),
  category: z.enum(CATEGORIES as [string, ...string[]]).optional().describe('SEP, MEP, MICRO, GYRO, HELI, TMG or GLIDER'),
  fuelTypes: z.array(z.string().max(30)).max(4).optional().describe('Approved fuels, preferred first: AVGAS100LL, AVGAS_UL91, MOGAS, JETA1'),
  hardRunwayOnly: z.boolean().optional(),
  transponder: z.enum(['none', 'A', 'C', 'S']).optional(),
  hasRadio: z.boolean().optional(),
  pages: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('POH page per field name, so the pilot can check'),
  ...Object.fromEntries((Object.keys(NUMERIC_LIMITS) as NumericField[]).map(k => {
    const [lo, hi] = NUMERIC_LIMITS[k]
    return [k, z.number().min(lo).max(hi).optional().describe(FIELD_HELP[k] ?? k)]
  })),
}

function toInput(a: Record<string, unknown>): AircraftInput {
  const values: Partial<Record<NumericField, number>> = {}
  for (const k of Object.keys(NUMERIC_LIMITS) as NumericField[]) if (typeof a[k] === 'number') values[k] = a[k] as number
  return {
    name: a['name'] as string | undefined, registration: a['registration'] as string | undefined,
    icaoType: a['icaoType'] as string | undefined, category: a['category'] as AircraftInput['category'],
    fuelTypes: a['fuelTypes'] as string[] | undefined, hardRunwayOnly: a['hardRunwayOnly'] as boolean | undefined,
    transponder: a['transponder'] as AircraftInput['transponder'], hasRadio: a['hasRadio'] as boolean | undefined,
    pages: a['pages'] as AircraftInput['pages'], values,
  }
}

function profileText(a: AircraftProfileDocType): string {
  const skip = new Set(['id', 'updatedAt', 'assistantReview'])
  return Object.entries(a).filter(([k, v]) => !skip.has(k) && v !== undefined && v !== '' && v !== 0)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v, 80) : Array.isArray(v) ? v.join(', ') : String(v)}`).join('\n')
}

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean }

/** Planned departure for a briefing: ISO 8601 with a time zone, from an hour ago to 16 days ahead. */
const departureField = z.string().max(40).optional()
  .describe('Planned departure, ISO 8601 with time zone, e.g. 2026-11-12T09:30:00Z. Default: the departure set in the app if still ahead, else now. Winds, times, NOTAMs and TAFs are for this time.')
function parseDeparture(v: string | undefined): number | undefined | Text {
  if (!v) return undefined
  const t = Date.parse(v)
  if (!Number.isFinite(t) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) return fail('departure must be ISO 8601 with a time zone, e.g. 2026-11-12T09:30:00Z.')
  if (t < Date.now() - 3_600_000 || t > Date.now() + 16 * 86_400_000) return fail('departure must be between an hour ago and 16 days ahead.')
  return t
}
const isText = (v: unknown): v is Text => typeof v === 'object' && v !== null && 'content' in v
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): Text => ({ content: [{ type: 'text', text: t }], isError: true })

interface Caller { userId: string; scopes: string[]; clientId: string }

export interface McpDeps {
  briefings: BriefingService
  weather: WeatherFor
  /** Web app origin, for links into the app. */
  appOrigin: string
  resource: string
  scopeBriefing: string
  scopeRoutes: string
  scopeAircraftWrite: string
  scopeRoutesWrite: string
  /** Save one of the user's routes (as the user), review mark included. */
  saveRoute: (userId: string, doc: RouteDocType) => Promise<void>
  /** Aerodromes, navaids and reporting points to resolve route points; null = not available. */
  pointIndex?: () => Promise<PointIndex | null>
  /** Save one of the user's aircraft profiles (as the user). */
  saveAircraft: (userId: string, doc: AircraftProfileDocType) => Promise<void>
  /** The assistant's name for the review mark and logs. */
  clientName: (clientId: string) => Promise<string>
  /** Counts one briefing against the user's briefing limit; false = over it. */
  takeBriefing: (userId: string) => boolean
  /**
   * Where token verification reads the signing keys (JWKS). The api's own
   * loopback address: its public URL may not be reachable from inside its
   * container, and would send every key refresh out through the edge.
   */
  jwksUrl: string
}

async function allAerodromes(): Promise<GeoJSON.FeatureCollection | null> {
  const available = (await getAvailableCountries())?.map(c => c.code) ?? []
  return loadCountryDataset('aerodromes', available.length > 0 ? available : ['se'])
}

let pointIndexCache: { at: number; idx: Promise<PointIndex | null> } | null = null
/** All served countries' points, rebuilt every hour (the datasets cache for longer). */
function defaultPointIndex(): Promise<PointIndex | null> {
  if (pointIndexCache && Date.now() - pointIndexCache.at < HOUR_MS) return pointIndexCache.idx
  const idx = (async () => {
    const available = (await getAvailableCountries())?.map(c => c.code) ?? []
    const cc = available.length > 0 ? available : ['se']
    const [aerodromes, navaids, waypoints, landmarks] = await Promise.all((['aerodromes', 'navaids', 'waypoints', 'landmarks'] as const).map(k => loadCountryDataset(k, cc)))
    return aerodromes ? buildPointIndex({ aerodromes, navaids, waypoints, landmarks } as never) : null
  })()
  pointIndexCache = { at: Date.now(), idx }
  void idx.then(i => { if (!i) pointIndexCache = null })
  return idx
}

function aircraftLabel(a: AircraftProfileDocType): string {
  return [a.registration, a.name ? quote(a.name, 80) : ''].filter(Boolean).join(' ') || 'aircraft'
}

function routeLine(r: RouteDocType): string {
  let nm = 0
  for (let i = 0; i < r.waypoints.length - 1; i++) nm += distanceNm(r.waypoints[i]!, r.waypoints[i + 1]!)
  const pts = r.waypoints.map((w, i) => (w.name || `WP${i + 1}`) + (w.fuelStop ? ' (fuel)' : '')).join(' → ')
  return `- ${quote(r.name || '(no name)', 80)}: ${quote(pts, 300)}, ${Math.round(nm)} NM`
}

export function createMcpEndpoint(auth: typeof authInstance, deps: McpDeps): (req: Request) => Promise<Response> {
  const adLink = (icao: string) => `${deps.appOrigin}/?ad=${encodeURIComponent(icao)}`

  function buildServer(caller: Caller): McpServer {
    const server = new McpServer({ name: 'openvfr', version: '1.0.0' })
    const canRoutes = caller.scopes.includes(deps.scopeRoutes)
    const noRoutes = () => fail('This assistant was not given access to your saved routes and aircraft. Reconnect it and allow "saved routes and aircraft".')

    async function findAircraft(name?: string): Promise<AircraftProfileDocType | null> {
      if (!name || !canRoutes) return null
      const key = name.trim().toLowerCase()
      const list = await deps.briefings.userAircraft({ id: caller.userId })
      return list.find(a => a.registration.toLowerCase() === key || a.name.toLowerCase() === key)
        ?? list.find(a => `${a.registration} ${a.name}`.toLowerCase().includes(key)) ?? null
    }

    /**
     * The aircraft to plan with when the pilot named none: the one selected
     * in the app, else the only profile. The note tells the model what was
     * chosen, or that it should ask.
     */
    async function defaultAircraft(): Promise<{ profile: AircraftProfileDocType | null; note: string }> {
      const d = await deps.briefings.defaultAircraft({ id: caller.userId })
      if (d.aircraft) return { profile: d.aircraft, note: `Planned with ${aircraftLabel(d.aircraft)} (${d.why}). If the pilot wants another aircraft, use its registration.` }
      if (d.choices.length > 1) return { profile: null, note: `No aircraft chosen, so no fuel or performance checks: the pilot has ${d.choices.length} aircraft (${d.choices.slice(0, 8).map(aircraftLabel).join(', ')}). Ask which one and pass it.` }
      return { profile: null, note: 'No aircraft profile in OpenVFR: no fuel or performance checks.' }
    }

    server.registerTool('list_saved_routes', {
      annotations: { readOnlyHint: true },
      description: "List the pilot's saved routes in OpenVFR (name, points, distance). Use a name with brief_saved_route or suggest_fuel_stops.",
      inputSchema: z.object({}),
    }, async () => {
      if (!canRoutes) return noRoutes()
      const routes = (await deps.briefings.savedRoutes({ id: caller.userId })).filter(r => r.id !== 'current')
      if (routes.length === 0) return text('No saved routes. Save a route in the OpenVFR app first.')
      return text(`Saved routes (newest first):\n${routes.slice(0, 30).map(routeLine).join('\n')}\n${QUOTE_NOTE}`)
    })

    server.registerTool('list_aircraft', {
      annotations: { readOnlyHint: true },
      description: "List the pilot's aircraft profiles in OpenVFR with the key planning numbers.",
      inputSchema: z.object({}),
    }, async () => {
      if (!canRoutes) return noRoutes()
      const list = await deps.briefings.userAircraft({ id: caller.userId })
      if (list.length === 0) return text('No aircraft profiles yet.')
      return text(list.map(a => `- ${aircraftLabel(a)} (${a.icaoType || a.category}): cruise ${a.cruiseIas} kt IAS, ${a.fuelBurnLhr} L/h, ${a.maxFuelL} L usable` +
        `${a.fuelTypes?.length ? `, fuel ${a.fuelTypes.map((f, i) => `${FUEL_LABELS[f]}${i === 0 ? ' (preferred)' : ''}`).join(', ')}` : ''}` +
        `${a.maxCrosswindKts ? `, max crosswind ${a.maxCrosswindKts} kt` : ''}`).join('\n') + `\n${QUOTE_NOTE}`)
    })

    server.registerTool('brief_saved_route', {
      annotations: { readOnlyHint: true },
      description: 'Pre-flight briefing of one of the pilot\'s saved routes: distance, time and fuel per hop, METAR/TAF and NOTAMs at the departure, fuel stops and destination, and warnings (airspace, NOTAM areas, fuel, equipment, crosswind, runway length). Read the warnings out first.',
      inputSchema: z.object({
        route: z.string().min(1).max(120).describe('Saved route name (or part of it) or id'),
        aircraft: z.string().max(80).optional().describe('Aircraft registration or name; default: the route\'s own aircraft, else the one selected in the app'),
        departure: departureField,
      }),
    }, async ({ route, aircraft, departure }) => {
      if (!canRoutes) return noRoutes()
      const dep = parseDeparture(departure)
      if (isText(dep)) return dep
      if (!deps.takeBriefing(caller.userId)) return fail('Briefing limit reached for now. Try again later.')
      try {
        const ac = await findAircraft(aircraft)
        if (aircraft && !ac) return fail(`No aircraft "${aircraft}". Use list_aircraft.`)
        let note = ''
        let acId = ac?.id
        if (!aircraft) {
          const found = await findRoute(route)
          if ('route' in found && !found.route.aircraftId) {
            const d = await defaultAircraft()
            acId = d.profile?.id
            note = `\n${d.note}`
          }
        }
        const r = await deps.briefings.briefSavedRoute({ id: caller.userId }, route, acId, dep)
        return text(briefingText(r.briefing) + note)
      } catch (err) {
        if (err instanceof BriefingInputError) return fail(err.message)
        throw err
      }
    })

    server.registerTool('brief_route', {
      annotations: { readOnlyHint: true },
      description: 'Pre-flight briefing for a route given as ICAO aerodrome codes in order, e.g. ["ESSB","ESMS"]. Optional aircraft (needs access to saved aircraft) adds fuel, crosswind and runway checks; mark intermediate aerodromes as fuel stops with fuelStops.',
      inputSchema: z.object({
        aerodromes: z.array(z.string().regex(/^[A-Za-z]{4}$/)).min(2).max(20).describe('ICAO codes in flight order'),
        fuelStops: z.array(z.string().regex(/^[A-Za-z]{4}$/)).max(10).optional().describe('Intermediate ICAO codes where the aircraft lands and refuels'),
        aircraft: z.string().max(80).optional(),
        cruiseAltFt: z.number().int().min(500).max(20000).optional().describe('Planned cruise altitude, ft'),
        departure: departureField,
      }),
    }, async ({ aerodromes, fuelStops, aircraft, cruiseAltFt, departure }) => {
      const dep = parseDeparture(departure)
      if (isText(dep)) return dep
      if (!deps.takeBriefing(caller.userId)) return fail('Briefing limit reached for now. Try again later.')
      const fc = await allAerodromes()
      if (!fc) return fail('Aerodrome data is not available right now.')
      const byIcao = new Map(parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike).map(a => [a.icao.toUpperCase(), a]))
      const stops = new Set((fuelStops ?? []).map(s => s.toUpperCase()))
      const waypoints: RouteWaypoint[] = []
      for (const code of aerodromes.map(a => a.toUpperCase())) {
        const ad = byIcao.get(code)
        if (!ad) return fail(`${code} is not in OpenVFR's aerodrome data.`)
        waypoints.push({ lat: ad.lat, lng: ad.lng, name: code, elevationFt: ad.elevationFt, ...(stops.has(code) ? { fuelStop: true } : {}) })
      }
      let ac = await findAircraft(aircraft)
      let chosen = ''
      if (!aircraft && canRoutes) {
        const d = await defaultAircraft()
        ac = d.profile
        chosen = `\n${d.note}`
      }
      const legOverrides = waypoints.slice(0, -1).map(() => (cruiseAltFt ? { altFt: cruiseAltFt } : {}))
      const b = await deps.briefings.briefRoute({ id: caller.userId }, { waypoints, legOverrides }, ac, dep !== undefined ? { departureMs: dep } : {})
      const note = aircraft && !ac ? (canRoutes ? `\n(No aircraft named "${aircraft}" found; briefed without one.)` : '\n(Aircraft not used: no access to saved aircraft.)') : ''
      return text(briefingText(b) + note + chosen)
    })

    server.registerTool('aerodrome_status', {
      annotations: { readOnlyHint: true },
      description: 'Current status of one aerodrome: runways, fuel, PPR, METAR/TAF, NOTAMs (with their texts) and, with an aircraft, whether the reported crosswind is within its limit.',
      inputSchema: z.object({
        icao: z.string().regex(/^[A-Za-z]{4}$/),
        aircraft: z.string().max(80).optional(),
      }),
    }, async ({ icao, aircraft }) => {
      const code = icao.toUpperCase()
      const fc = await allAerodromes()
      const f = fc?.features.find(x => String((x.properties as Record<string, unknown> | null)?.['icao'] ?? '').toUpperCase() === code)
      const ad = f ? parseAerodromesGeoJson({ features: [f] } as unknown as AerodromeFeatureCollectionLike)[0] : undefined
      const wx = await deps.weather(caller.userId, code).catch(() => null)
      const notams = (getNotamsForIcao(code).notams as unknown as NotamItem[])
        .filter(n => !n.expires || Date.parse(n.expires) > Date.now())
      const lines: string[] = []
      lines.push(ad ? `${code} ${quote(ad.name, 80)}, elevation ${ad.elevationFt} ft. ${adLink(code)}` : `${code} (not in OpenVFR's aerodrome data).`)
      if (ad) {
        const rwys = (ad.runways ?? []).map(r => `${r.lengthM} m ${r.surface || '?'}`).join(', ')
        lines.push(`Runways: ${rwys || 'unknown'}. Fuel listed: ${ad.fuel.join(', ') || 'none'}.${ad.ppr ? ' PPR required.' : ''}`)
      }
      lines.push(`METAR: ${wx?.metar ? quote(wx.metar, 300) : 'not available'}`)
      if (wx?.taf) lines.push(`TAF: ${quote(wx.taf, 600)}`)
      const ac = await findAircraft(aircraft)
      if (ac && fc && wx?.metar) {
        const w = metarSurfaceWind(wx.metar)
        if (w && ac.maxCrosswindKts) {
          const x = crosswindExceedances([{ icao: code, role: 'aerodrome' }], new Map([[code, w]]), thresholdsByIcao(fc), ac.maxCrosswindKts)
          lines.push(x.length ? `Crosswind ${x[0]!.crosswindKt} kt on the best runway, above ${aircraftLabel(ac)}'s ${ac.maxCrosswindKts} kt limit.` : `Crosswind within ${aircraftLabel(ac)}'s ${ac.maxCrosswindKts} kt limit.`)
        }
      }
      const ns = notamStatus()
      lines.push(!ns.available ? 'NOTAMs: not available right now, none checked.' : notams.length === 0 ? `No current NOTAMs (data from ${ns.asOf?.slice(11, 16) ?? '?'}Z).` : `${notams.length} NOTAM${notams.length > 1 ? 's' : ''} (data from ${ns.asOf?.slice(11, 16) ?? '?'}Z):`)
      for (const n of notams.slice(0, 15)) lines.push(`- ${n.id} ${quote(notamTitle(n), 120)} (${n.effective ?? '?'} to ${n.expires ?? 'PERM'}): ${quote(n.text, 600)}`)
      lines.push(QUOTE_NOTE)
      lines.push(BRIEFING_DISCLAIMER)
      return text(lines.join('\n'))
    })

    server.registerTool('suggest_fuel_stops', {
      annotations: { readOnlyHint: true },
      description: "Suggest aerodromes along one of the pilot's saved routes to land and refuel, matching the aircraft's fuel types (preferred first) and runway limits, with each hop's time and fuel left on landing.",
      inputSchema: z.object({
        route: z.string().min(1).max(120),
        aircraft: z.string().max(80).optional(),
      }),
    }, async ({ route, aircraft }) => {
      if (!canRoutes) return noRoutes()
      const routes = await deps.briefings.savedRoutes({ id: caller.userId })
      const key = route.trim().toLowerCase()
      const r = routes.find(x => x.id === route) ?? routes.find(x => x.name.toLowerCase() === key) ?? routes.find(x => x.name.toLowerCase().includes(key))
      if (!r) return fail('No saved route with that name.')
      const ac = (await findAircraft(aircraft)) ?? (await deps.briefings.aircraftById({ id: caller.userId }, r.aircraftId))
      if (!ac) return fail('No aircraft for this route. Name one of the saved aircraft.')
      const fc = await allAerodromes()
      if (!fc) return fail('Aerodrome data is not available right now.')
      const res = suggestFuelStops(r.waypoints, r.legOverrides, ac, parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike))
      if (res.status === 'not-needed') return text(`${r.name} needs no fuel stop with ${aircraftLabel(ac)} (planned without wind).`)
      if (res.status === 'missing-profile-data') return fail('The aircraft profile needs cruise speed, fuel burn and usable fuel.')
      if (res.status === 'none-found') return text('No aerodrome near the route fits the aircraft\'s fuel and runway limits. Add a stop by hand in the app.')
      const out = res.plans.map((p, i) => `${i + 1}. ` + p.stops.map(s =>
        `${s.aerodrome.icao} ${quote(s.aerodrome.name, 80)} (${s.fuels.map(f => FUEL_LABELS[f]).join('/') || s.aerodrome.fuel.join('/')}` +
        `${s.fuelRank > 0 ? `, ${preferenceLabel(s.fuelRank)} choice` : ''}, ${s.aerodrome.maxRunwayM} m${s.aerodrome.ppr ? ', PPR' : ''}) ${adLink(s.aerodrome.icao)}`).join(' then ') +
        `; hops ${p.hops.map(h => `${h.from}→${h.to} ${Math.round(h.enrouteMins)} min, ${Math.round(h.landingFuelL)} L left`).join('; ')}; +${Math.round(p.extraMins)} min flying.`)
      return text(`Fuel stop options for ${quote(r.name, 80)} with ${aircraftLabel(ac)}:\n${out.join('\n')}\nFuel listings come from published aerodrome data and can be out of date: check the AIP or call ahead. Add a stop in the app with "Suggest fuel stop".\n${QUOTE_NOTE}`)
    })

    // ── Prompt: a pre-flight briefing in the right order ──────────────────
    // Offered by assistants in their prompt menu; it only instructs the model,
    // the data still comes from the tools above.
    server.registerPrompt('preflight_briefing', {
      title: 'Pre-flight briefing',
      description: 'Brief a flight with OpenVFR data: route, fuel, weather, NOTAMs and warnings, most important first.',
      argsSchema: z.object({
        route: z.string().min(2).max(120).describe('A saved route name, or ICAO codes in order, e.g. "ESSB ESMS"'),
        aircraft: z.string().max(80).optional().describe('Aircraft registration or name (optional)'),
        when: z.string().max(60).optional().describe('Planned departure, e.g. "tomorrow 09:00 UTC" (optional)'),
      }),
    }, ({ route, aircraft, when }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Give me a pre-flight briefing for ${route}${aircraft ? ` with ${aircraft}` : ''}${when ? `, departing ${when}` : ''}, using the OpenVFR tools.`,
            /^[A-Za-z]{4}(\s+[A-Za-z]{4})+$/.test(route.trim())
              ? '1. Call brief_route with these ICAO codes in order.'
              : '1. Call brief_saved_route with this route (list_saved_routes if the name is unclear).',
            ...(when ? [`   Pass departure as an ISO 8601 UTC time for "${when}" (ask me if unclear): winds, times, NOTAMs and TAFs are for that time.`] : []),
            '2. Read daylight problems and the serious warnings first, then the other warnings, fuel per hop, the altitude per leg, and weather (METAR, the TAF for the time I am there, weather along the way) and NOTAMs at each aerodrome where I take off or land. Mention the "Also check" items.',
            '3. If fuel is short on a hop, call suggest_fuel_stops. For anything about one aerodrome, call aerodrome_status.',
            '4. Say what the briefing could not check (it lists that), and end by reminding me that this is not an official briefing.',
            'Keep it short enough to read out. Quote NOTAM numbers and times exactly; do not invent values the tools did not give.',
          ].join('\n'),
        },
      }],
    }))

    // ── Aircraft profiles: read one, create, update (never delete) ─────────
    const canWrite = caller.scopes.includes(deps.scopeAircraftWrite)
    const noWrite = () => fail('This assistant may not change aircraft profiles. Reconnect it and allow "add and change your aircraft profiles", or make the change in the OpenVFR app.')

    server.registerTool('get_aircraft', {
      description: "All fields of one of the pilot's aircraft profiles (by registration or name).",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ aircraft: z.string().min(1).max(80) }),
    }, async ({ aircraft }) => {
      if (!canRoutes) return noRoutes()
      const a = await findAircraft(aircraft)
      if (!a) return fail(`No aircraft "${aircraft}". Use list_aircraft.`)
      const review = a.assistantReview ? `\n(Check before use: ${a.assistantReview.change === 'created' ? 'added' : 'changed'} by ${a.assistantReview.by}, not yet reviewed in the app.)` : ''
      return text(`${aircraftLabel(a)}\n${profileText(a)}${review}\n${QUOTE_NOTE}`)
    })

    const saveBuild = async (built: ReturnType<typeof buildAircraft>, verb: string): Promise<Text> => {
      await deps.saveAircraft(caller.userId, built.doc)
      console.log(`[mcp] aircraft ${verb} user=${caller.userId} client=${caller.clientId} id=${built.doc.id} fields=${built.changed.join(',')}`)
      const lines = [`${verb === 'created' ? 'Added' : 'Updated'} ${aircraftLabel(built.doc)} in OpenVFR${verb === 'updated' ? `: ${built.changed.filter(c => c !== 'updatedAt').join(', ') || 'nothing changed'}` : ''}.`]
      if (built.warnings.length) lines.push(`Values that look wrong, check them against the POH: ${built.warnings.join('; ')}.`)
      if (built.defaults.length) lines.push(`Defaults used (no value given): ${built.defaults.join(', ')}.`)
      lines.push('The app shows it as "check before use" until the pilot opens and saves it there. It appears on their devices at the next sync.')
      return text(lines.join('\n'))
    }

    server.registerTool('create_aircraft', {
      description: 'Add an aircraft profile for the pilot, e.g. from an attached POH/AFM. Give only values the document states, converted to the units in each field description, with the POH page per field in `pages`. Needs a registration; powered aircraft need cruiseIas, fuelBurnLhr and maxFuelL (USABLE fuel). The values are checked and the profile is marked for the pilot to review in the app.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({ registration: z.string().min(2).max(20).describe('Registration, e.g. SE-ABC'), ...aircraftFields }),
    }, async (args) => {
      if (!canWrite) return noWrite()
      if (writeLimiter.take(caller.userId).waitS > 0) return fail('Too many changes for now. Try again later.')
      const existing = (await deps.briefings.userAircraft({ id: caller.userId })).find(a => a.registration.toUpperCase() === String(args.registration).trim().toUpperCase())
      if (existing) return fail(`${existing.registration} already exists. Use update_aircraft to change it.`)
      try {
        const built = buildAircraft(toInput(args as Record<string, unknown>), { newId: crypto.randomUUID(), by: await deps.clientName(caller.clientId), now: Date.now() })
        return await saveBuild(built, 'created')
      } catch (err) {
        if (err instanceof AircraftInputError) return fail(err.message)
        throw err
      }
    })

    server.registerTool('update_aircraft', {
      description: "Change fields of one of the pilot's aircraft profiles (by registration or name). Only the given fields change; units as in each field description. Cannot delete a profile.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({ aircraft: z.string().min(1).max(80).describe('Registration or name of the profile to change'), registration: z.string().min(2).max(20).optional().describe('New registration'), ...aircraftFields }),
    }, async (args) => {
      if (!canWrite) return noWrite()
      if (writeLimiter.take(caller.userId).waitS > 0) return fail('Too many changes for now. Try again later.')
      const existing = await findAircraft(String(args.aircraft))
      if (!existing) return fail(`No aircraft "${args.aircraft}". Use list_aircraft.`)
      try {
        const { aircraft: _target, ...fields } = args as Record<string, unknown>
        const built = buildAircraft(toInput(fields), { existing, newId: existing.id, by: await deps.clientName(caller.clientId), now: Date.now() })
        if (built.changed.length === 0) return text(`Nothing to change on ${aircraftLabel(existing)}.`)
        return await saveBuild(built, 'updated')
      } catch (err) {
        if (err instanceof AircraftInputError) return fail(err.message)
        throw err
      }
    })

    // ── Routes: read one, create, update (never delete) ──────────────────
    const canRoutesWrite = caller.scopes.includes(deps.scopeRoutesWrite)
    const noRoutesWrite = () => fail('This assistant may not create or change routes. Reconnect it and allow "create and change your saved routes", or plan the route in the OpenVFR app.')
    const routeLink = (id: string) => `${deps.appOrigin}/?route=${encodeURIComponent(id)}`

    async function findRoute(key: string): Promise<{ route: RouteDocType } | { error: Text }> {
      const routes = (await deps.briefings.savedRoutes({ id: caller.userId })).filter(r => r.id !== 'current')
      const k = key.trim().toLowerCase()
      const exact = routes.find(r => r.id === key.trim()) ?? routes.find(r => r.name.toLowerCase() === k)
      if (exact) return { route: exact }
      const part = routes.filter(r => r.name.toLowerCase().includes(k))
      if (part.length === 1) return { route: part[0]! }
      if (part.length > 1) return { error: fail(`Several routes match "${key}": ${part.slice(0, 8).map(r => quote(r.name, 80)).join(', ')}. Use the full name.\n${QUOTE_NOTE}`) }
      return { error: fail(`No saved route "${key}". Use list_saved_routes.`) }
    }

    async function aircraftFor(name: string | undefined): Promise<{ id: string; profile: AircraftProfileDocType | null } | { error: Text } | null> {
      if (name === undefined) return null
      if (name.trim() === '' || /^none$/i.test(name.trim())) return { id: '', profile: null }
      const key = name.trim().toLowerCase()
      const list = await deps.briefings.userAircraft({ id: caller.userId })
      const a = list.find(x => x.registration.toLowerCase() === key || x.name.toLowerCase() === key)
      return a ? { id: a.id, profile: a } : { error: fail(`No aircraft "${name}". Use list_aircraft, or leave aircraft out.`) }
    }

    // Identifiers and coordinates as they are; any other point name (typed by
    // the pilot or imported) is outside text.
    const pointName = (n: string) => (/^[A-Z0-9]{2,6}(\/[A-Z0-9 ]{2,20})?$|^\d+\.\d+[NS] \d+\.\d+[EW]$/.test(n) ? n : quote(n, 40))
    function routeText(r: RouteDocType): string {
      return `${quote(r.name, 80)}:\n${legLines(r, pointName).join('\n')}`
    }

    server.registerTool('leg_altitudes', {
      description: "Altitude planning per leg of a saved route (create_route and update_route answers already include the same table: call this after they returned, not in parallel): minimum safe altitude (terrain, obstacles and the pilot's own margins), controlled airspace over the leg (floor, ceiling, where along the leg, frequency), restricted areas, and a suggested altitude that stays clear of terrain, below controlled airspace where possible, and on a VFR semicircular level. When the MSA reaches controlled airspace it says so and lists the options (clearance or route around); it never suggests flying below the MSA. Change levels with update_route.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ route: z.string().min(1).max(120).describe('Saved route name or id') }),
    }, async ({ route }) => {
      if (!canRoutes) return noRoutes()
      if (!deps.takeBriefing(caller.userId)) return fail('Briefing limit reached for now. Try again later.')
      try {
        const r = await deps.briefings.briefSavedRoute({ id: caller.userId }, route)
        const b = r.briefing
        const src = b.terrainSource === 'dem' ? 'Terrain from the elevation model.' : b.terrainSource === 'grid' ? 'Terrain from the maximum-elevation grid (conservative: highest point per ~460 m cell).' : 'No terrain data: minimum safe altitudes unknown.'
        const msaWarn = b.warnings.filter(w => /MSA|minimum safe|terrain|obstacle/i.test(`${w.title} ${w.detail}`))
        return text([
          `Altitudes for ${quote(r.route.name, 80)} (planned altitudes as saved; default altitude where a leg has none). ${src}`,
          ...b.legs.map(legLine),
          ...(msaWarn.length ? ['Related warnings:', ...msaWarn.map(w => `- ${w.leg ? `(leg ${w.leg}) ` : ''}${w.title}: ${quote(w.detail, 300)}`)] : []),
          'Airspace data can be out of date and activity times are not checked: confirm with the AIP and NOTAMs.',
          QUOTE_NOTE,
          BRIEFING_DISCLAIMER,
        ].join('\n'))
      } catch (err) {
        if (err instanceof BriefingInputError) return fail(err.message)
        throw err
      }
    })

    server.registerPrompt('plan_route', {
      title: 'Plan a VFR route',
      description: 'Plan and save a VFR route with OpenVFR: points, altitudes that respect terrain and controlled airspace, fuel stops, then a briefing.',
      argsSchema: z.object({
        from: z.string().min(2).max(40).describe('Departure, e.g. ESSB'),
        to: z.string().min(2).max(40).describe('Destination, e.g. ESSV'),
        aircraft: z.string().max(80).optional().describe('Aircraft registration or name (optional)'),
        wishes: z.string().max(300).optional().describe('E.g. "stay below the TMAs", "via the coast", "max 2 h legs" (optional)'),
      }),
    }, ({ from, to, aircraft, wishes }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Plan a VFR route from ${from} to ${to}${aircraft ? ` with ${aircraft}` : ''} in OpenVFR and save it.${wishes ? ` My wishes: ${wishes}.` : ''}`,
            aircraft
              ? '1. Propose points (ICAO codes, navaids, reporting points as AERODROME/POINT, or coordinates) and save them with create_route, with the aircraft and autoFuelStops: true.'
              : '1. If I have more than one aircraft (list_aircraft), ask me which one first. Then propose points (ICAO codes, navaids, reporting points as AERODROME/POINT, or coordinates) and save them with create_route with that aircraft and autoFuelStops: true; say which aircraft you planned with.',
            '2. Call leg_altitudes. For each leg use the suggested altitude unless I asked otherwise (it names what sets each MSA: mention it). Where the MSA reaches controlled airspace, tell me and offer the options it lists: a clearance (with the frequency), or a way around it, finding points with points_near (airspace name, route and leg) that have no controlled airspace above them or a higher floor. Never plan a leg below its MSA.',
            '3. Apply the altitudes and any point changes with update_route, then read the new briefing: fix what it warns about (airspace, restricted areas, fuel) and repeat once if needed.',
            '4. Finish with a short summary: legs with altitude and why, fuel stops, open issues, and the link to the route. Say that I must check it in the app before use and that this is not an official briefing.',
            'Use only numbers the tools give; ask me instead of guessing.',
          ].join('\n'),
        },
      }],
    }))

    const KIND_IN: Record<string, PointKind> = { aerodrome: 'aerodrome', navaid: 'navaid', 'reporting point': 'waypoint', landmark: 'landmark' }
    function nearLine(p: NearPoint): string {
      const kind = p.kind === 'waypoint' ? 'reporting point' : p.kind
      const what = p.kind === 'landmark' ? `landmark, ${p.detail.replace(/_/g, ' ')}` : p.kind === 'waypoint' ? p.detail : `${kind}${p.detail && p.detail !== p.identifier ? ` ${quote(p.detail, 40)}` : ''}`
      const where = p.edgeNm !== undefined ? `${Math.abs(p.edgeNm)} NM ${p.edgeNm >= 0 ? 'outside' : 'inside'} the edge`
        : p.alongNm !== undefined ? `NM ${p.alongNm} along the leg, ${p.distNm.toFixed(1)} NM ${p.side} of track`
        : `${p.distNm.toFixed(1)} NM away`
      const above = p.controlledAbove
        ? `${p.controlledAbove.floorFt <= 0 ? 'inside' : 'under'} ${p.controlledAbove.name} (class ${p.controlledAbove.cls}${p.controlledAbove.floorFt > 0 ? ` from ${p.controlledAbove.floorFt.toLocaleString('en-US')} ft` : ', from the surface'})`
        : 'no controlled airspace above'
      const id = /^[A-Z0-9]{2,6}(\/[A-Z0-9 ]{2,20})?$/.test(p.identifier) ? p.identifier : quote(p.identifier, 60)
      return `- ${id} (${what}): ${where}; ${above}`
    }

    server.registerTool('points_near', {
      description: 'Find route points near a place, along a leg of a saved route, or just outside (or inside) a named airspace, to plan a way around it: aerodromes, navaids, VFR reporting points and named landmarks (churches, water towers, windmills). Each comes with the identifier to use in create_route/update_route and the lowest controlled airspace above it, so you can pick points below a TMA floor or outside a control zone. Then check the result with leg_altitudes.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        near: z.string().min(2).max(60).optional().describe('Centre: an identifier (ESSB, ARL, ESSB/LAVER) or coordinates (5939N01756E)'),
        route: z.string().min(1).max(120).optional().describe('Saved route name, with leg'),
        leg: z.number().int().min(1).max(MAX_POINTS).optional().describe('Leg number of the route (1 = first to second point)'),
        airspace: z.string().min(2).max(60).optional().describe('Airspace name as in warnings and leg_altitudes, e.g. "STOCKHOLM F": points near its edge (with route+leg: only near that leg)'),
        inside: z.boolean().optional().describe('With airspace: points inside it near the edge instead of outside'),
        radiusNm: z.number().min(1).max(30).optional().describe('Search distance, NM (default 10): from the centre, the leg, or the airspace edge'),
        kinds: z.array(z.enum(['aerodrome', 'navaid', 'reporting point', 'landmark'])).max(4).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
    }, async (args) => {
      const idx = await (deps.pointIndex ?? defaultPointIndex)()
      if (!idx) return fail('Aerodrome and navaid data is not available right now.')
      const pts = allPoints(idx)
      const available = (await getAvailableCountries())?.map(c => c.code) ?? []
      const airspaceFc = await loadCountryDataset('airspace', available.length > 0 ? available : ['se'])
      const radius = args.radiusNm ?? 10
      const kinds = args.kinds?.map(k => KIND_IN[k]!)
      const opts = { ...(kinds ? { kinds } : {}), airspace: airspaceFc, limit: args.limit ?? 15 }
      let leg: [RouteWaypoint, RouteWaypoint] | null = null
      if (args.route || args.leg) {
        if (!canRoutes) return noRoutes()
        if (!args.route || !args.leg) return fail('Give both route and leg.')
        const found = await findRoute(args.route)
        if ('error' in found) return found.error
        const w = found.route.waypoints
        if (args.leg > w.length - 1) return fail(`That route has ${w.length - 1} legs.`)
        leg = [w[args.leg - 1]!, w[args.leg]!]
      }
      let head: string
      let list: NearPoint[]
      if (args.airspace) {
        if (!airspaceFc) return fail('Airspace data is not available right now.')
        const r = pointsNearAirspaceEdge(pts, airspaceFc, args.airspace, radius, { ...opts, ...(args.inside ? { inside: true } : {}), ...(leg ? { near: leg, nearNm: 15 } : {}) })
        if (r.matched.length === 0) return fail(`No airspace named "${args.airspace}". Use the names from warnings or leg_altitudes.`)
        if (r.matched.length > 1) return fail(`Several airspaces match: ${r.matched.slice(0, 10).join(', ')}. Use the full name.`)
        head = `Points ${args.inside ? 'inside' : 'outside'} ${r.matched[0]} within ${radius} NM of its edge${leg ? ` near leg ${args.leg}` : ''}:`
        list = r.points
      } else if (leg) {
        head = `Points within ${radius} NM of leg ${args.leg} (${leg[0].name ?? '?'} → ${leg[1].name ?? '?'}):`
        list = pointsNearLeg(pts, leg[0], leg[1], radius, opts)
      } else if (args.near) {
        const c = resolveRoutePoints([args.near], idx)[0]!
        if (!c.ok) return fail(`${args.near}: ${c.reason}.`)
        head = `Points within ${radius} NM of ${args.near.toUpperCase()}:`
        list = pointsNearPosition(pts, c.point, radius, opts).filter(p => p.distNm > 0.05)
      } else {
        return fail('Give near, route and leg, or airspace.')
      }
      if (list.length === 0) return text(`${head} none found. Try a larger radiusNm or other kinds.`)
      return text([head, ...list.map(nearLine), 'Landmarks are named buildings from OpenStreetMap: check they are visible from the air before using them as turning points.', QUOTE_NOTE].join('\n'))
    })

    server.registerTool('get_route', {
      description: "One of the pilot's saved routes in detail: every point, each leg's distance, altitude and speed, fuel stops, the aircraft, and a link that opens it in OpenVFR.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ route: z.string().min(1).max(120).describe('Saved route name (or part of it) or id') }),
    }, async ({ route }) => {
      if (!canRoutes) return noRoutes()
      const found = await findRoute(route)
      if ('error' in found) return found.error
      const r = found.route
      const ac = await deps.briefings.aircraftById({ id: caller.userId }, r.aircraftId)
      const review = r.assistantReview ? `\n(Check before use: ${r.assistantReview.change === 'created' ? 'made' : 'changed'} by ${r.assistantReview.by}, not yet saved by the pilot in the app.)` : ''
      return text(`Route ${routeText(r)}\nAircraft: ${ac ? aircraftLabel(ac) : 'none'}. Open: ${routeLink(r.id)}${review}\n${QUOTE_NOTE}`)
    })

    const routeFields = {
      altitudeFt: z.number().min(ALT_LIMITS[0]).max(ALT_LIMITS[1]).optional().describe('Cruise altitude for every leg, ft AMSL'),
      legs: z.array(z.object({
        leg: z.number().int().min(1).max(MAX_POINTS - 1).describe('Leg number, 1 = first point to second'),
        altitudeFt: z.number().min(ALT_LIMITS[0]).max(ALT_LIMITS[1]).optional().describe('ft AMSL'),
        speedKts: z.number().min(SPEED_LIMITS[0]).max(SPEED_LIMITS[1]).optional().describe('Planned IAS, kt'),
      })).max(MAX_POINTS - 1).optional().describe('Settings for single legs (after altitudeFt)'),
      fuelStops: z.array(z.string().max(40)).max(10).optional().describe('Points (aerodromes between departure and destination) where the aircraft lands and refuels; replaces the current set'),
      aircraft: z.string().max(80).optional().describe('Aircraft registration or name from list_aircraft; "none" for no aircraft. New routes without it use the aircraft selected in the app (or the only one) and say so'),
      departure: departureField,
      autoFuelStops: z.boolean().optional().describe('With an aircraft: when a hop needs more fuel than the tanks hold, insert the best fuel stop (aircraft fuel types and runway limits) and say which'),
    }
    const pointsField = z.array(z.string().min(2).max(40)).min(2).max(MAX_POINTS)
      .describe('Points in flight order: ICAO aerodrome codes (ESSB), navaid idents (ARL), reporting points as AERODROME/POINT (ESSB/LAVER), named landmarks as LM/<name> (LM/Hassela kyrka), or coordinates (5939N01756E). Use points_near to find them. Unknown or ambiguous points are refused, never guessed.')

    /** Insert the best fuel stop plan into a built route when a hop is too long. Returns a note for the answer. */
    async function addFuelStops(built: ReturnType<typeof buildRoute>, ac: AircraftProfileDocType | null): Promise<string> {
      if (!ac) return 'No fuel stops added: give an aircraft for that.'
      const fc = await allAerodromes()
      if (!fc) return 'No fuel stops added: aerodrome data is not available right now.'
      const res = suggestFuelStops(built.doc.waypoints, built.doc.legOverrides, ac, parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike))
      if (res.status === 'not-needed') return `No fuel stop needed with ${aircraftLabel(ac)} (planned with the leg winds set on the route, if any).`
      if (res.status === 'missing-profile-data') return 'No fuel stops added: the aircraft profile needs cruise speed, fuel burn and usable fuel.'
      if (res.status === 'none-found') return 'A fuel stop is needed, but no aerodrome near the route fits the aircraft\'s fuels and runway limits: choose one yourself.'
      const plan = res.plans[0]!
      const next = insertFuelStops(built.doc.waypoints, built.doc.legOverrides, plan)
      built.doc.waypoints = next.waypoints
      built.doc.legOverrides = next.legOverrides
      if (!built.changed.includes('fuel stops') && !built.changed.includes('created')) built.changed.push('fuel stops')
      const review = built.doc.assistantReview
      if (review && review.change !== 'created' && !review.change.includes('fuel stops')) built.doc.assistantReview = { ...review, change: [...review.change, 'fuel stops'] }
      const others = res.plans.slice(1).map(p => p.stops.map(x => x.aerodrome.icao).join('+')).join(', ')
      return `Added fuel stop${plan.stops.length > 1 ? 's' : ''} ${plan.stops.map(x => `${x.aerodrome.icao} ${quote(x.aerodrome.name, 60)} (${x.fuels.map(f => FUEL_LABELS[f]).join('/') || x.aerodrome.fuel.join('/')}, ${x.aerodrome.maxRunwayM} m${x.aerodrome.ppr ? ', PPR' : ''})`).join(' and ')}, +${Math.round(plan.extraMins)} min.${others ? ` Other options: ${others}.` : ''} Fuel listings can be out of date: the pilot should call ahead.`
    }

    async function saveRouteAndBrief(built: ReturnType<typeof buildRoute>, ac: AircraftProfileDocType | null, verb: 'created' | 'updated', note = '', departureMs?: number): Promise<Text> {
      await deps.saveRoute(caller.userId, built.doc)
      console.log(`[mcp] route ${verb} user=${caller.userId} client=${caller.clientId} id=${built.doc.id} change=${built.changed.join(',')}`)
      const lines = [
        `${verb === 'created' ? 'Saved new route' : `Updated route (${built.changed.join(', ') || 'nothing changed'})`} ${routeText(built.doc)}`,
        `Open it in OpenVFR: ${routeLink(built.doc.id)}`,
        'The app marks it "check before use" until the pilot opens and saves it there; it reaches their devices at the next sync.',
      ]
      if (note) lines.push(note)
      if (built.warnings.length) lines.push(`Check these: ${built.warnings.join('; ')}.`)
      if (deps.takeBriefing(caller.userId)) {
        const b = await deps.briefings.briefRoute({ id: caller.userId }, { waypoints: built.doc.waypoints, legOverrides: built.doc.legOverrides }, ac, departureMs !== undefined ? { departureMs } : {})
        lines.push('', 'Briefing of the saved route (fix warnings with update_route):', briefingText(b))
      } else {
        lines.push('(Briefing limit reached: brief it later with brief_saved_route.)', QUOTE_NOTE)
      }
      return text(lines.join('\n'))
    }

    server.registerTool('create_route', {
      description: 'Save a new route for the pilot in OpenVFR and brief it. Points are resolved against OpenVFR data; the answer has the legs, a link that opens the route in the app, and the briefing warnings (airspace, terrain, fuel, NOTAMs, weather) so you can improve the route with update_route. Plan VFR only; the pilot checks the route in the app before use.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        name: z.string().min(1).max(80).optional().describe('Route name; default "FROM – TO"'),
        points: pointsField,
        ...routeFields,
      }),
    }, async (args) => {
      if (!canRoutesWrite) return noRoutesWrite()
      const dep = parseDeparture(args.departure)
      if (isText(dep)) return dep
      if (writeLimiter.take(caller.userId).waitS > 0) return fail('Too many changes for now. Try again later.')
      const idx = await (deps.pointIndex ?? defaultPointIndex)()
      if (!idx) return fail('Aerodrome and navaid data is not available right now.')
      let ac = await aircraftFor(args.aircraft)
      if (ac && 'error' in ac) return ac.error
      let chosen = ''
      if (args.aircraft === undefined) {
        const d = await defaultAircraft()
        if (d.profile) ac = { id: d.profile.id, profile: d.profile }
        chosen = d.note
      }
      if (args.name) {
        const clash = (await deps.briefings.savedRoutes({ id: caller.userId })).find(r => r.id !== 'current' && r.name.toLowerCase() === args.name!.trim().toLowerCase())
        if (clash) return fail(`A route named ${quote(clash.name, 80)} exists. Use update_route to change it, or choose another name.`)
      }
      try {
        const input: RouteInput = { name: args.name, points: args.points, altitudeFt: args.altitudeFt, legs: args.legs, fuelStops: args.fuelStops, aircraftId: ac?.id }
        const built = buildRoute(input, { idx, newId: crypto.randomUUID(), by: await deps.clientName(caller.clientId), now: Date.now() })
        const note = [chosen, args.autoFuelStops ? await addFuelStops(built, ac?.profile ?? null) : ''].filter(Boolean).join('\n')
        return await saveRouteAndBrief(built, ac?.profile ?? null, 'created', note, dep)
      } catch (err) {
        if (err instanceof RouteInputError) return fail(err.message)
        throw err
      }
    })

    server.registerTool('update_route', {
      description: "Change one of the pilot's saved routes: new point list (points already on the route keep their settings), altitude for all or single legs, speed, fuel stops, aircraft, name. Only the given fields change. Answers with the legs, link and a new briefing. Cannot delete a route.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        route: z.string().min(1).max(120).describe('Saved route name or id'),
        name: z.string().min(1).max(80).optional().describe('New name'),
        points: pointsField.optional(),
        ...routeFields,
      }),
    }, async (args) => {
      if (!canRoutesWrite) return noRoutesWrite()
      const dep = parseDeparture(args.departure)
      if (isText(dep)) return dep
      if (writeLimiter.take(caller.userId).waitS > 0) return fail('Too many changes for now. Try again later.')
      const found = await findRoute(args.route)
      if ('error' in found) return found.error
      const existing = found.route
      const idx = args.points ? await (deps.pointIndex ?? defaultPointIndex)() : buildPointIndex({})
      if (!idx) return fail('Aerodrome and navaid data is not available right now.')
      const ac = await aircraftFor(args.aircraft)
      if (ac && 'error' in ac) return ac.error
      try {
        const input: RouteInput = { name: args.name, points: args.points, altitudeFt: args.altitudeFt, legs: args.legs, fuelStops: args.fuelStops, aircraftId: ac?.id }
        const built = buildRoute(input, { existing, idx, newId: existing.id, by: await deps.clientName(caller.clientId), now: Date.now() })
        const profile = ac ? ac.profile : await deps.briefings.aircraftById({ id: caller.userId }, built.doc.aircraftId)
        const note = args.autoFuelStops ? await addFuelStops(built, profile) : ''
        if (built.changed.length === 0) return text(`Nothing to change on ${quote(existing.name, 80)}.${note ? ` ${note}` : ''}\n${QUOTE_NOTE}`)
        return await saveRouteAndBrief(built, profile, 'updated', note, dep)
      } catch (err) {
        if (err instanceof RouteInputError) return fail(err.message)
        throw err
      }
    })

    return server
  }

  const handler = createMcpHandler(({ authInfo }) => {
    const extra = (authInfo?.extra ?? {}) as { sub?: string }
    return buildServer({ userId: extra.sub ?? '', scopes: authInfo?.scopes ?? [], clientId: authInfo?.clientId ?? '' })
  })

  return requireMcpAuth(auth, async (request, claims) => {
    const userId = typeof claims.sub === 'string' ? claims.sub : ''
    if (!userId) return new Response('Forbidden', { status: 403 })
    const limit = mcpLimiter.take(userId)
    if (limit.waitS > 0) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests. Try again later.' }, id: null }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.min(limit.waitS, 3600)) },
      })
    }
    const scopes = typeof claims['scope'] === 'string' ? (claims['scope'] as string).split(' ').filter(Boolean) : []
    return handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: typeof claims['azp'] === 'string' ? claims['azp'] as string : '',
        scopes,
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
        extra: { sub: userId },
      },
    })
  }, {
    resource: deps.resource,
    jwksUrl: deps.jwksUrl,
    requiredScopes: [deps.scopeBriefing],
    // Advertised in the 401 challenge: clients ask for what is listed here,
    // so list saved routes (the pilot can still leave them out on the consent
    // page) and offline_access (refresh tokens, no sign-in every hour).
    challengeScopes: [deps.scopeBriefing, deps.scopeRoutes, deps.scopeRoutesWrite, deps.scopeAircraftWrite, 'offline_access'],
  })
}
