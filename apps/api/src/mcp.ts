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
 *   briefing:read  public aviation data and briefings (every token)
 *   routes:read    the user's saved routes and aircraft profiles
 *
 * Every tool only reads. Answers are short text meant to be read out or
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
import { suggestFuelStops } from '@open-vfr/shared/fuelStops'
import { FUEL_LABELS, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { metarSurfaceWind, crosswindExceedances, thresholdsByIcao } from '@open-vfr/shared/crosswindCheck'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { briefingText, BRIEFING_DISCLAIMER } from './briefing'
import { quote, QUOTE_NOTE } from './untrusted'
import { BriefingInputError, type BriefingService, type WeatherFor } from './briefingService'
import { loadCountryDataset } from './briefingData'
import { getAvailableCountries } from './countries'
import { getNotamsForIcao, notamStatus } from './notam'
import { RateLimiter, limitFromEnv } from './rateLimiter'
import { buildAircraft, AircraftInputError, CATEGORIES, NUMERIC_LIMITS, type AircraftInput, type NumericField } from './aircraftTools'
import type { auth as authInstance } from './auth'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Tool calls per user, on top of the briefing and weather limits the tools also use. */
const mcpLimiter = new RateLimiter([
  { windowMs: HOUR_MS, max: limitFromEnv('MCP_HOURLY_LIMIT', 120) },
  { windowMs: DAY_MS,  max: limitFromEnv('MCP_DAILY_LIMIT', 600) },
])

/** Aircraft profile writes per user: few are ever needed. */
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
        aircraft: z.string().max(80).optional().describe('Aircraft registration or name; default: the route\'s own aircraft'),
      }),
    }, async ({ route, aircraft }) => {
      if (!canRoutes) return noRoutes()
      if (!deps.takeBriefing(caller.userId)) return fail('Briefing limit reached for now. Try again later.')
      try {
        const ac = await findAircraft(aircraft)
        const r = await deps.briefings.briefSavedRoute({ id: caller.userId }, route, ac?.id)
        return text(briefingText(r.briefing))
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
      }),
    }, async ({ aerodromes, fuelStops, aircraft, cruiseAltFt }) => {
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
      const ac = await findAircraft(aircraft)
      const legOverrides = waypoints.slice(0, -1).map(() => (cruiseAltFt ? { altFt: cruiseAltFt } : {}))
      const b = await deps.briefings.briefRoute({ id: caller.userId }, { waypoints, legOverrides }, ac)
      const note = aircraft && !ac ? (canRoutes ? `\n(No aircraft named "${aircraft}" found; briefed without one.)` : '\n(Aircraft not used: no access to saved aircraft.)') : ''
      return text(briefingText(b) + note)
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
            '2. Read the serious warnings first, then the other warnings, fuel per hop, and weather and NOTAMs at each aerodrome where I take off or land.',
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
      if (writeLimiter.take(caller.userId).waitS > 0) return fail('Too many aircraft changes for now. Try again later.')
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
      if (writeLimiter.take(caller.userId).waitS > 0) return fail('Too many aircraft changes for now. Try again later.')
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
    challengeScopes: [deps.scopeBriefing, deps.scopeRoutes, deps.scopeAircraftWrite, 'offline_access'],
  })
}
