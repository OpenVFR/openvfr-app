/**
 * What every MCP tool module shares (see mcp.ts): the caller and their
 * scopes, the lookups (saved routes, aircraft, points, places), the one place
 * writes are rate-limited, and the tool registrar that turns an error into a
 * short, safe answer. The tool modules (mcpBriefingTools.ts, mcpRouteTools.ts,
 * ...) only register tools on this context.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AircraftProfileDocType, RouteDocType, UserWaypointDocType } from '@open-vfr/shared/types'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { buildPointIndex, withPlaces, type PointIndex } from '@open-vfr/shared/routeIdentifiers'
import { DEFAULT_REGION_CODES } from '@open-vfr/shared/regions'
import { quote, QUOTE_NOTE } from './untrusted'
import { BriefingInputError, findSavedRoute, parseDepartureTime, type BriefingService, type WeatherFor } from './briefingService'
import { loadCountryDataset, WriteConflictError, type FlightSummary } from './briefingData'
import { getAvailableCountries } from './countries'
import { RateLimiter, limitFromEnv } from './rateLimiter'
import { AircraftInputError } from './aircraftTools'
import { RouteInputError } from './routeTools'
import { PlaceInputError } from './placeTools'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export type Text = { content: { type: 'text'; text: string }[]; isError?: boolean }
export const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })
export const fail = (t: string): Text => ({ content: [{ type: 'text', text: t }], isError: true })
export const isText = (v: unknown): v is Text => typeof v === 'object' && v !== null && 'content' in v

export interface Caller { userId: string; scopes: string[]; clientId: string }

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
  scopeLogs: string
  /**
   * Save one of the user's routes (as the user), review mark included. With
   * `seenUpdatedAt` (a change to an existing route) it is refused when the
   * route changed since it was read.
   */
  saveRoute: (userId: string, doc: RouteDocType, seenUpdatedAt?: number) => Promise<void>
  /** Aerodromes, navaids and reporting points to resolve route points; null = not available. */
  pointIndex?: () => Promise<PointIndex | null>
  /** The user's saved places. */
  places: (userId: string) => Promise<UserWaypointDocType[]>
  /** Save one of the user's saved places (as the user). */
  savePlace: (userId: string, doc: UserWaypointDocType, seenUpdatedAt?: number) => Promise<void>
  /** The user's latest logged flights, newest first, without GPS tracks. */
  flights: (userId: string) => Promise<FlightSummary[]>
  /** Save one of the user's aircraft profiles (as the user). */
  saveAircraft: (userId: string, doc: AircraftProfileDocType, seenUpdatedAt?: number) => Promise<void>
  /** The assistant's name for the review mark and logs (plain, short text). */
  clientName: (clientId: string) => Promise<string>
  /** Counts one briefing against the user's briefing limit; false = over it. */
  takeBriefing: (userId: string) => boolean
  /** Whether the user may still use this assistant: not banned, and the consent is still there. */
  /** The scopes the pilot's consent grants now, or null when the assistant has no access (disconnected, account banned). Throws when the check itself fails. */
  access: (userId: string, clientId: string) => Promise<string[] | null>
  /**
   * Where token verification reads the signing keys (JWKS). The api's own
   * loopback address: its public URL may not be reachable from inside its
   * container, and would send every key refresh out through the edge.
   */
  jwksUrl: string
}

/** Route and aircraft writes per user: few are ever needed. */
const writeLimiter = new RateLimiter([
  { windowMs: HOUR_MS, max: limitFromEnv('MCP_WRITE_HOURLY_LIMIT', 20) },
  { windowMs: DAY_MS,  max: limitFromEnv('MCP_WRITE_DAILY_LIMIT', 60) },
])

class WriteLimitError extends Error {}

/** Planned departure for a briefing: ISO 8601 with a time zone, from an hour ago to 16 days ahead. */
export const departureField = z.string().max(40).optional()
  .describe('Planned departure, ISO 8601 with time zone, e.g. 2026-11-12T09:30:00Z. Default: the departure set in the app if still ahead, else now. Winds, times, NOTAMs and TAFs are for this time. Not stored on the route: pass it again on every call that briefs.')

/** The departure in ms, undefined when none was given, or an error answer. */
export function parseDeparture(v: string | undefined): number | undefined | Text {
  if (!v) return undefined
  const d = parseDepartureTime(v, Date.now(), true)
  return d.ok ? d.ms : fail(d.error)
}

// ── Data every tool module reads ────────────────────────────────────────────

/** Countries this deployment serves, else the default region. */
export async function servedCountries(): Promise<string[]> {
  const available = (await getAvailableCountries())?.map(c => c.code) ?? []
  return available.length > 0 ? available : [...DEFAULT_REGION_CODES]
}

export async function allAerodromes(): Promise<GeoJSON.FeatureCollection | null> {
  return loadCountryDataset('aerodromes', await servedCountries())
}

let pointIndexCache: { at: number; ttlMs: number; idx: Promise<PointIndex | null> } | null = null
/**
 * All served countries' points, rebuilt every hour (the datasets cache for
 * longer). An index with a dataset missing is kept only a minute, so a
 * transient failure does not make identifiers unknown for an hour.
 */
export function defaultPointIndex(): Promise<PointIndex | null> {
  if (pointIndexCache && Date.now() - pointIndexCache.at < pointIndexCache.ttlMs) return pointIndexCache.idx
  const built = (async () => {
    const cc = await servedCountries()
    const [aerodromes, navaids, waypoints, landmarks] = await Promise.all(
      (['aerodromes', 'navaids', 'waypoints', 'landmarks'] as const).map(k => loadCountryDataset(k, cc)))
    return { index: aerodromes ? buildPointIndex({ aerodromes, navaids, waypoints, landmarks }) : null, complete: !!(aerodromes && navaids && waypoints && landmarks) }
  })()
  const entry = { at: Date.now(), ttlMs: HOUR_MS, idx: built.then(b => b.index) }
  pointIndexCache = entry
  void built.then(
    (b) => { if (!b.index) { if (pointIndexCache === entry) pointIndexCache = null } else if (!b.complete) entry.ttlMs = 60_000 },
    () => { if (pointIndexCache === entry) pointIndexCache = null },
  )
  return entry.idx
}

export function aircraftLabel(a: AircraftProfileDocType): string {
  return [a.registration ? quote(a.registration, 20) : '', a.name && a.name !== a.registration ? quote(a.name, 80) : ''].filter(Boolean).join(' ') || 'aircraft'
}

export function routeLine(r: RouteDocType): string {
  let nm = 0
  for (let i = 0; i < r.waypoints.length - 1; i++) nm += distanceNm(r.waypoints[i]!, r.waypoints[i + 1]!)
  const pts = r.waypoints.map((w, i) => (w.name || `WP${i + 1}`) + (w.fuelStop ? ' (fuel)' : '')).join(' → ')
  return `- ${quote(r.name || '(no name)', 80)}: ${quote(pts, 300)}, ${Math.round(nm)} NM`
}

// ── The per-caller context ─────────────────────────────────────────────────

export type AircraftChoice =
  | { error: Text }
  | { profile: AircraftProfileDocType | null; /** undefined = the caller named none (leave it as it is) */ id: string | undefined; note: string }

export interface ToolConfig<S extends z.ZodType> {
  title?: string
  description: string
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
  inputSchema: S
}

export interface Ctx {
  server: McpServer
  deps: McpDeps
  caller: Caller
  canRoutes: boolean
  canAircraftWrite: boolean
  canRoutesWrite: boolean
  canLogs: boolean
  /** Reading saved routes, places and aircraft is needed by every tool that reads them, and by every change (they read what they change). */
  noRoutes: () => Text
  noAircraftWrite: () => Text
  noRoutesWrite: () => Text
  noLogs: () => Text
  adLink: (icao: string) => string
  routeLink: (id: string) => string
  /**
   * The point index; with the pilot's saved places (PL/<name>) when a token asks for one
   * and they allowed reading them. An error answer when the data (or the places) cannot be read.
   */
  pointIndex: (tokens?: readonly string[]) => Promise<{ idx: PointIndex } | { error: Text }>
  /** The index without places (never fails on the user's data). */
  publicPointIndex: () => Promise<PointIndex | null>
  /** The pilot's saved places; a failed read is an error answer, never "none". */
  places: () => Promise<UserWaypointDocType[] | { error: Text }>
  /** One resolver for saved routes (see findSavedRoute): an error answer when none or ambiguous. */
  findRoute: (key: string) => Promise<{ route: RouteDocType } | { error: Text }>
  /** The aircraft named, else (when `useDefault`) the app's selected one or the only one; one resolver for every tool. */
  resolveAircraft: (name: string | undefined, opts?: { useDefault?: boolean; allowNone?: boolean }) => Promise<AircraftChoice>
  /** Counts a briefing against the user's limit; an answer when over it. Call after the input is checked. */
  takeBriefing: () => Text | null
  /** Register a tool; an error inside it becomes a short answer (internal ones are logged, not shown). */
  tool: <S extends z.ZodType>(name: string, config: ToolConfig<S>, handler: (args: z.infer<S>) => Promise<Text>) => void
  /** Saves: each one counts against the write limit, after the input is validated, and logs who did it. */
  save: {
    route: (doc: RouteDocType, seenUpdatedAt?: number) => Promise<void>
    aircraft: (doc: AircraftProfileDocType, seenUpdatedAt?: number) => Promise<void>
    place: (doc: UserWaypointDocType, seenUpdatedAt?: number) => Promise<void>
  }
}

export function createCtx(server: McpServer, deps: McpDeps, caller: Caller): Ctx {
  const has = (scope: string) => caller.scopes.includes(scope)
  const canRoutes = has(deps.scopeRoutes)
  const noRoutes = () => fail('This assistant was not given access to your saved routes, places and aircraft (needed to read and to change them). Reconnect it and allow "saved routes, places and aircraft".')

  const publicPointIndex = () => (deps.pointIndex ?? defaultPointIndex)()

  async function places(): Promise<UserWaypointDocType[] | { error: Text }> {
    try { return await deps.places(caller.userId) } catch (err) {
      console.error(`[mcp] places unavailable user=${caller.userId} client=${caller.clientId}:`, err)
      return { error: fail('Your saved places are not available right now. Try again later.') }
    }
  }

  async function pointIndex(tokens: readonly string[] = []): Promise<{ idx: PointIndex } | { error: Text }> {
    const idx = await publicPointIndex()
    if (!idx) return { error: fail('Aerodrome and navaid data is not available right now.') }
    if (!canRoutes || !tokens.some(t => /^PL\//i.test(t.trim()))) return { idx }
    const p = await places()
    return 'error' in p ? p : { idx: withPlaces(idx, p) }
  }

  async function findRoute(key: string): Promise<{ route: RouteDocType } | { error: Text }> {
    const found = findSavedRoute(await deps.briefings.savedRoutes({ id: caller.userId }), key)
    if ('route' in found) return found
    if (found.error === 'several') return { error: fail(`Several routes match "${quote(key, 80)}": ${found.names.slice(0, 8).map(n => quote(n, 80)).join(', ')}. Use the full name.\n${QUOTE_NOTE}`) }
    return { error: fail(found.error === 'empty' ? 'Give the name or id of a saved route.' : `No saved route "${quote(key, 80)}". Use list_saved_routes.`) }
  }

  async function resolveAircraft(name: string | undefined, opts: { useDefault?: boolean; allowNone?: boolean } = {}): Promise<AircraftChoice> {
    const given = name !== undefined && name.trim() !== ''
    // "none" (or blank) where that is allowed: no aircraft on purpose.
    if (name !== undefined && opts.allowNone && (!given || /^none$/i.test(name.trim()))) return { profile: null, id: '', note: '' }
    if (given) {
      if (!canRoutes) return { profile: null, id: undefined, note: '(Aircraft not used: no access to saved aircraft.)' }
      const key = name!.trim().toLowerCase()
      const list = await deps.briefings.userAircraft({ id: caller.userId })
      const exact = list.find(a => a.registration.toLowerCase() === key || a.name.toLowerCase() === key)
      const part = list.filter(a => `${a.registration} ${a.name}`.toLowerCase().includes(key))
      const hit = exact ?? (part.length === 1 ? part[0] : undefined)
      if (hit) return { profile: hit, id: hit.id, note: '' }
      if (part.length > 1) return { error: fail(`Several aircraft match ${quote(name, 40)}: ${part.slice(0, 8).map(aircraftLabel).join(', ')}. Use the registration.\n${QUOTE_NOTE}`) }
      return { error: fail(`No aircraft ${quote(name, 40)}. Use list_aircraft${opts.allowNone ? ', or leave aircraft out' : ''}.`) }
    }
    if (!opts.useDefault || !canRoutes) return { profile: null, id: undefined, note: '' }
    const d = await deps.briefings.defaultAircraft({ id: caller.userId })
    if (d.aircraft) return { profile: d.aircraft, id: d.aircraft.id, note: `Planned with ${aircraftLabel(d.aircraft)} (${d.why}). If the pilot wants another aircraft, use its registration.` }
    if (d.choices.length > 1) return { profile: null, id: undefined, note: `No aircraft chosen, so no fuel or performance checks: the pilot has ${d.choices.length} aircraft (${d.choices.slice(0, 8).map(aircraftLabel).join(', ')}). Ask which one and pass it.` }
    return { profile: null, id: undefined, note: 'No aircraft profile in OpenVFR: no fuel or performance checks.' }
  }

  const take = (): void => { if (writeLimiter.take(caller.userId).waitS > 0) throw new WriteLimitError() }

  const tool: Ctx['tool'] = (name, config, handler) => {
    server.registerTool(name, config as never, (async (args: never) => {
      try {
        return await handler(args)
      } catch (err) {
        // Input mistakes are the model's to fix; anything else is ours: log it, show nothing internal.
        if (err instanceof BriefingInputError || err instanceof RouteInputError || err instanceof AircraftInputError || err instanceof PlaceInputError || err instanceof WriteConflictError) return fail(err.message)
        if (err instanceof WriteLimitError) return fail('Too many changes for now. Try again later.')
        console.error(`[mcp] tool ${name} failed user=${caller.userId} client=${caller.clientId}:`, err)
        return fail('Something went wrong on the server. Try again later.')
      }
    }) as never)
  }

  return {
    server, deps, caller, canRoutes,
    canAircraftWrite: has(deps.scopeAircraftWrite),
    canRoutesWrite: has(deps.scopeRoutesWrite),
    canLogs: has(deps.scopeLogs),
    noRoutes,
    noAircraftWrite: () => fail('This assistant may not change aircraft profiles. Reconnect it and allow "add and change your aircraft profiles", or make the change in the OpenVFR app.'),
    noRoutesWrite: () => fail('This assistant may not create or change routes and places. Reconnect it and allow "create and change your saved routes and places", or do it in the OpenVFR app.'),
    noLogs: () => fail('This assistant was not given access to your flight log summaries. Reconnect it and allow "summaries of your logged flights".'),
    adLink: icao => `${deps.appOrigin}/?ad=${encodeURIComponent(icao)}`,
    routeLink: id => `${deps.appOrigin}/?route=${encodeURIComponent(id)}`,
    pointIndex, publicPointIndex, places, findRoute, resolveAircraft,
    takeBriefing: () => (deps.takeBriefing(caller.userId) ? null : fail('Briefing limit reached for now. Try again later.')),
    tool,
    save: {
      route: async (doc, seen) => { take(); await deps.saveRoute(caller.userId, doc, seen) },
      aircraft: async (doc, seen) => { take(); await deps.saveAircraft(caller.userId, doc, seen) },
      place: async (doc, seen) => { take(); await deps.savePlace(caller.userId, doc, seen) },
    },
  }
}
