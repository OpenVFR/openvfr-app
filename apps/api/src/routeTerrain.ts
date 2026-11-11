/**
 * Terrain along a route for server-side briefings, from this deployment's
 * own DEM archives (demElevation.ts) -- the same samples the apps' elevation
 * proxy answers with. No third-party elevation API is called here: when the
 * DEM does not cover the whole route this throws and the briefing falls back
 * to the conservative maximum-elevation grid.
 */
import { fetchTerrainProfile, type TerrainPoint } from '@open-vfr/shared/virtualRadarCalc'
import type { ElevationLookup } from '@open-vfr/shared/terrainDem'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'

const FT_PER_M = 3.28084
/** Never reached: fetchTerrainProfile only asks the API when the DEM misses, which must fail here. */
const NO_API = 'http://127.0.0.1:9'

export function demLookup(dem: (locations: string) => Promise<string | null>): ElevationLookup {
  return {
    async elevationFt(lat, lng) {
      const raw = await dem(`${lat.toFixed(5)},${lng.toFixed(5)}`)
      if (!raw) return null
      const m = (JSON.parse(raw) as { results?: { elevation: number | null }[] }).results?.[0]?.elevation
      return typeof m === 'number' ? Math.round(m * FT_PER_M) : null
    },
  }
}

export function demRouteTerrain(dem: ((locations: string) => Promise<string | null>) | null):
  ((waypoints: RouteWaypoint[]) => Promise<TerrainPoint[]>) | undefined {
  if (!dem) return undefined
  const lookup = demLookup(dem)
  return (waypoints) => fetchTerrainProfile(waypoints, NO_API, AbortSignal.timeout(20_000), lookup, { preferLookup: true })
}
