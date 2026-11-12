/**
 * Briefing for one signed-in user: resolves a saved route (or a route sent
 * in the request) and its aircraft, wires the data loaders and builds the
 * briefing. Shared by POST /api/briefing and the assistant (MCP) tools.
 */
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import type { LegOverride, AircraftProfileDocType, RouteDocType } from '@open-vfr/shared/types'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { buildRouteBriefing, type RouteBriefing } from './briefing'
import { loadCountryDataset, loadMefGridsFor, routeCountries, userAircraft, userRoutes, userDataConfigured, userPlanningSettings } from './briefingData'
import type { TerrainPoint } from '@open-vfr/shared/virtualRadarCalc'
import { fetchWindForecastMany } from '@open-vfr/shared/windForecast'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getNotamsForIcao, getRegionalNotams, notamStatus } from './notam'
import { getAvailableCountries } from './countries'

/**
 * The user a server-side briefing runs for: the in-process Open-Meteo fetch
 * (index.ts) charges that user's proxy caps.
 */
const briefingUser = new AsyncLocalStorage<string>()
export function currentBriefingUser(): string | undefined { return briefingUser.getStore() }

/** Furthest ahead a departure can be briefed (forecast horizon). */
export const MAX_DEPARTURE_AHEAD_MS = 16 * 24 * 60 * 60 * 1000
/** Furthest back a departure can be briefed. */
export const MAX_DEPARTURE_PAST_MS = 60 * 60 * 1000

/**
 * A planned departure given as an ISO 8601 time, from an hour ago to 16 days
 * ahead. `requireZone`: a time without a zone is refused (an assistant cannot
 * know the server's zone).
 */
export function parseDepartureTime(value: string, now = Date.now(), requireZone = false): { ok: true; ms: number } | { ok: false; error: string } {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || (requireZone && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value))) return { ok: false, error: `departure must be ISO 8601${requireZone ? ' with a time zone' : ''}, e.g. 2026-11-12T09:30:00Z.` }
  if (ms < now - MAX_DEPARTURE_PAST_MS || ms > now + MAX_DEPARTURE_AHEAD_MS) return { ok: false, error: 'departure must be between an hour ago and 16 days ahead.' }
  return { ok: true, ms }
}

/**
 * The saved route a name or id means: the one place this is decided, for the
 * briefing and the assistant tools. An exact id or name, else a name that
 * contains the text once; several matches or none are an error. The working
 * route ('current') is only ever matched by its id, when `allowCurrent`.
 */
export function findSavedRoute(routes: readonly RouteDocType[], key: string, allowCurrent = false): { route: RouteDocType } | { error: 'empty' | 'none' } | { error: 'several'; names: string[] } {
  const k = key.trim().toLowerCase()
  if (!k) return { error: 'empty' }
  const named = routes.filter(r => r.id !== 'current')
  const exact = routes.find(r => r.id === key.trim() && (allowCurrent || r.id !== 'current')) ?? named.find(r => r.name.trim().toLowerCase() === k)
  if (exact) return { route: exact }
  const part = named.filter(r => r.name.toLowerCase().includes(k))
  if (part.length === 1) return { route: part[0]! }
  if (part.length > 1) return { error: 'several', names: part.map(r => r.name) }
  return { error: 'none' }
}

/** The plain-text message of a failed findSavedRoute (for the REST briefing). */
export function savedRouteError(e: { error: 'empty' | 'none' } | { error: 'several'; names: string[] }): string {
  if (e.error === 'several') return `Several routes match: ${e.names.slice(0, 8).join(', ')}. Use the full name.`
  return e.error === 'empty' ? 'Give the name or id of a saved route.' : 'No saved route with that name.'
}

export type WeatherFor = (userId: string, icao: string) => Promise<{ metar: string | null; taf: string | null } | null>

export class BriefingInputError extends Error {}

const MAX_POINTS = 100

/** Validate a route sent by a client: 2..100 points with real coordinates. */
export function parseRouteInput(body: unknown): { waypoints: RouteWaypoint[]; legOverrides: LegOverride[] } {
  const b = (body ?? {}) as Record<string, unknown>
  const raw = b['waypoints']
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_POINTS) {
    throw new BriefingInputError(`A route needs 2 to ${MAX_POINTS} points.`)
  }
  const waypoints: RouteWaypoint[] = raw.map((w, i) => {
    const r = (w ?? {}) as Record<string, unknown>
    const lat = Number(r['lat']), lng = Number(r['lng'])
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new BriefingInputError(`Point ${i + 1} has no valid position.`)
    }
    const name = typeof r['name'] === 'string' ? r['name'].trim().toUpperCase().slice(0, 16) : undefined
    return { lat, lng, ...(name ? { name } : {}), ...(r['fuelStop'] === true ? { fuelStop: true } : {}) }
  })
  const ovRaw = Array.isArray(b['legOverrides']) ? b['legOverrides'] : []
  const legOverrides: LegOverride[] = waypoints.slice(0, -1).map((_, i) => {
    const o = (ovRaw[i] ?? {}) as Record<string, unknown>
    const out: LegOverride = {}
    const alt = Number(o['altFt']); if (Number.isFinite(alt) && alt > 0 && alt < 60000) out.altFt = alt
    const spd = Number(o['speedKts']); if (Number.isFinite(spd) && spd > 0 && spd < 600) out.speedKts = spd
    return out
  })
  return { waypoints, legOverrides }
}

export function createBriefingService(deps: {
  weather: WeatherFor
  /** Terrain samples along a route from the deployment's DEM (see index.ts); absent = grid only. */
  terrain?: (waypoints: RouteWaypoint[]) => Promise<TerrainPoint[]>
}) {
  async function briefRoute(
    user: { id: string }, route: { waypoints: RouteWaypoint[]; legOverrides: LegOverride[] }, aircraft: AircraftProfileDocType | null,
    opts: { departureMs?: number } = {},
  ): Promise<RouteBriefing> {
    const available = (await getAvailableCountries())?.map(c => c.code) ?? null
    const countries = routeCountries(route.waypoints, available)
    const { takeoffMs, selectedAircraftId: _sel, unreadable, ...settings } = userDataConfigured() ? await userPlanningSettings(user.id) : {}
    const now = Date.now()
    // Departure: asked for, else the one set in the app if still ahead, else now.
    const departureMs = opts.departureMs ?? (takeoffMs && takeoffMs > now - MAX_DEPARTURE_PAST_MS && takeoffMs < now + MAX_DEPARTURE_AHEAD_MS ? takeoffMs : now)
    return briefingUser.run(user.id, () => buildRouteBriefing(
      { waypoints: route.waypoints, legOverrides: route.legOverrides, aircraft, nowMs: now, departureMs, ...settings, ...(unreadable ? { settingsUnreadable: true } : {}) },
      {
        loadDataset: kind => loadCountryDataset(kind, countries),
        ...(deps.terrain ? { terrain: deps.terrain } : {}),
        mefGrids: () => loadMefGridsFor(countries),
        legWinds: pts => fetchWindForecastMany(pts, '', AbortSignal.timeout(20_000)),
        // The api's NOTAM records carry the same fields the shared checks read.
        regionalNotams: at => getRegionalNotams(countries, at).notams as unknown as NotamItem[],
        aerodromeNotams: (icao, at) => getNotamsForIcao(icao, at).notams as unknown as NotamItem[],
        notamStatus,
        weather: icao => deps.weather(user.id, icao),
      },
    ))
  }

  async function savedRoutes(user: { id: string }): Promise<RouteDocType[]> {
    if (!userDataConfigured()) return []
    return userRoutes(user.id)
  }

  async function aircraftById(user: { id: string }, id: string | undefined | null): Promise<AircraftProfileDocType | null> {
    if (!id || !userDataConfigured()) return null
    return (await userAircraft(user.id)).find(a => a.id === id) ?? null
  }

  /** Brief one of the user's saved routes: the route itself, or its id or name (see findSavedRoute). */
  async function briefSavedRoute(user: { id: string }, idOrName: string | RouteDocType, aircraftId?: string, departureMs?: number): Promise<{ route: RouteDocType; briefing: RouteBriefing }> {
    let route: RouteDocType
    if (typeof idOrName === 'string') {
      const found = findSavedRoute(await savedRoutes(user), idOrName, true)
      if ('error' in found) throw new BriefingInputError(savedRouteError(found))
      route = found.route
    } else route = idOrName
    const aircraft = await aircraftById(user, aircraftId || route.aircraftId)
    const briefing = await briefRoute(user, { waypoints: route.waypoints, legOverrides: route.legOverrides }, aircraft, departureMs !== undefined ? { departureMs } : {})
    return { route, briefing }
  }

  /**
   * The aircraft to plan with when none is named: the one selected in the
   * app, else the only profile; null with the reason otherwise.
   */
  async function defaultAircraft(user: { id: string }): Promise<{ aircraft: AircraftProfileDocType; why: string } | { aircraft: null; choices: AircraftProfileDocType[] }> {
    if (!userDataConfigured()) return { aircraft: null, choices: [] }
    const [list, s] = await Promise.all([userAircraft(user.id), userPlanningSettings(user.id)])
    const sel = s.selectedAircraftId ? list.find(a => a.id === s.selectedAircraftId) : undefined
    if (sel) return { aircraft: sel, why: 'the aircraft selected in the app' }
    if (list.length === 1) return { aircraft: list[0]!, why: 'the only aircraft profile' }
    return { aircraft: null, choices: list }
  }

  return { briefRoute, briefSavedRoute, savedRoutes, aircraftById, defaultAircraft, userAircraft: (user: { id: string }) => userDataConfigured() ? userAircraft(user.id) : Promise.resolve([]) }
}

export type BriefingService = ReturnType<typeof createBriefingService>
