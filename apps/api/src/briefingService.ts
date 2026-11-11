/**
 * Briefing for one signed-in user: resolves a saved route (or a route sent
 * in the request) and its aircraft, wires the data loaders and builds the
 * briefing. Shared by POST /api/briefing and the assistant (MCP) tools.
 */
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import type { LegOverride, AircraftProfileDocType, RouteDocType } from '@open-vfr/shared/types'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { buildRouteBriefing, type RouteBriefing } from './briefing'
import { loadCountryDataset, routeCountries, userAircraft, userRoutes, userDataConfigured } from './briefingData'
import { getNotamsForIcao, getRegionalNotams, notamStatus } from './notam'
import { getAvailableCountries } from './countries'

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

export function createBriefingService(opts: { weather: WeatherFor }) {
  async function briefRoute(user: { id: string }, route: { waypoints: RouteWaypoint[]; legOverrides: LegOverride[] }, aircraft: AircraftProfileDocType | null): Promise<RouteBriefing> {
    const available = (await getAvailableCountries())?.map(c => c.code) ?? null
    const countries = routeCountries(route.waypoints, available)
    return buildRouteBriefing(
      { waypoints: route.waypoints, legOverrides: route.legOverrides, aircraft, nowMs: Date.now() },
      {
        loadDataset: kind => loadCountryDataset(kind, countries),
        // The api's NOTAM records carry the same fields the shared checks read.
        regionalNotams: () => getRegionalNotams(countries).notams as unknown as NotamItem[],
        aerodromeNotams: icao => getNotamsForIcao(icao).notams as unknown as NotamItem[],
        notamStatus,
        weather: icao => opts.weather(user.id, icao),
      },
    )
  }

  async function savedRoutes(user: { id: string }): Promise<RouteDocType[]> {
    if (!userDataConfigured()) return []
    return userRoutes(user.id)
  }

  async function aircraftById(user: { id: string }, id: string | undefined | null): Promise<AircraftProfileDocType | null> {
    if (!id || !userDataConfigured()) return null
    return (await userAircraft(user.id)).find(a => a.id === id) ?? null
  }

  /** Brief one of the user's saved routes, by id or (case-insensitive) name. */
  async function briefSavedRoute(user: { id: string }, idOrName: string, aircraftId?: string): Promise<{ route: RouteDocType; briefing: RouteBriefing }> {
    const routes = await savedRoutes(user)
    const key = idOrName.trim().toLowerCase()
    const route = routes.find(r => r.id === idOrName) ?? routes.find(r => r.name.trim().toLowerCase() === key)
      ?? routes.find(r => r.name.trim().toLowerCase().includes(key))
    if (!route) throw new BriefingInputError('No saved route with that name.')
    const aircraft = await aircraftById(user, aircraftId || route.aircraftId)
    const briefing = await briefRoute(user, { waypoints: route.waypoints, legOverrides: route.legOverrides }, aircraft)
    return { route, briefing }
  }

  return { briefRoute, briefSavedRoute, savedRoutes, aircraftById, userAircraft: (user: { id: string }) => userDataConfigured() ? userAircraft(user.id) : Promise.resolve([]) }
}

export type BriefingService = ReturnType<typeof createBriefingService>
