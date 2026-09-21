/**
 * findDestination — "Find a Destination" aerodrome finder logic, shared by
 * web's FindDestPanel.tsx and native's FindDestinationSheet.tsx.
 *
 * Parses the se-aerodromes.geojson FeatureCollection into a flat searchable
 * list, then filters/sorts by free-text search, fuel type, surface, minimum
 * runway length, and (when airborne with a known glide ratio) glide range.
 */

import type { AircraftProfileDocType } from './types'
import { distanceNm, bearingDeg, type RouteWaypoint } from './routeCalc'

export interface AerodromeEntry {
  icao:        string
  name:        string
  lat:         number
  lng:         number
  elevationFt: number
  maxRunwayM:  number
  surfaces:    string[]   // unique surface codes: ASPH, GRASS, CONC, SAND
  fuel:        string[]
  type:        string
}

export interface AerodromeResult extends AerodromeEntry {
  dist:        number  // NM from centre
  bearing:     number  // deg true from centre
  withinGlide: boolean
}

export type FuelFilter    = 'any' | 'avgas' | 'jet'
export type SurfaceFilter = 'any' | 'hard'  | 'grass'

export interface FindDestCentre {
  lat: number
  lng: number
  /** altitude ft — used for glide range when > 200 ft */
  altFt?: number
}

export interface FindDestFilters {
  search?:      string
  minRunwayM?:  number
  fuelFilter?:  FuelFilter
  surfFilter?:  SurfaceFilter
}

// ── GeoJSON parsing ─────────────────────────────────────────────────────────

function parseMaybeJsonArray<T>(val: unknown): T[] {
  if (Array.isArray(val))          return val as T[]
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T[] } catch { return [] }
  }
  return []
}

/** Minimal shape needed from the se-aerodromes.geojson FeatureCollection —
 *  avoids a hard dependency on @types/geojson from this shared package. */
export interface AerodromeFeatureCollectionLike {
  features: {
    geometry:   { coordinates: [number, number] }
    properties: Record<string, unknown>
  }[]
}

export function parseAerodromesGeoJson(fc: AerodromeFeatureCollectionLike): AerodromeEntry[] {
  const entries: AerodromeEntry[] = []
  for (const f of fc.features) {
    const p = f.properties
    const runways = parseMaybeJsonArray<Record<string, unknown>>(p.runways)
    let maxRunwayM = 0
    const surfSet = new Set<string>()
    for (const rwy of runways) {
      const len = Number(rwy.length_m ?? 0)
      if (len > maxRunwayM) maxRunwayM = len
      const surf = String(rwy.surface ?? '').toUpperCase()
      if (surf) surfSet.add(surf)
    }
    entries.push({
      icao:        String(p.icao  ?? ''),
      name:        String(p.name  ?? ''),
      lat:         f.geometry.coordinates[1],
      lng:         f.geometry.coordinates[0],
      elevationFt: Number(p.elevation_ft ?? 0),
      maxRunwayM,
      surfaces:    [...surfSet],
      fuel:        parseMaybeJsonArray<string>(p.fuel),
      type:        String(p.type ?? 'AD'),
    })
  }
  return entries
}

// ── Filter helpers ──────────────────────────────────────────────────────────

export function isHard(surfaces: string[])  { return surfaces.some(s => s === 'ASPH' || s === 'CONC') }
export function isGrass(surfaces: string[]) { return surfaces.some(s => s === 'GRASS' || s === 'SAND') }
export function hasAvgas(fuel: string[])    { return fuel.some(f => f === 'AVGAS' || f.startsWith('100')) }
export function hasJet(fuel: string[])      { return fuel.some(f => f === 'A1' || f.startsWith('JET')) }

/** Straight-line glide range in NM, or null when not airborne / no glide data. */
export function computeGlideRangeNm(
  centre: FindDestCentre,
  aircraftProfile?: Pick<AircraftProfileDocType, 'glideRatio'>,
): number | null {
  const altFt = centre.altFt ?? 0
  if (!aircraftProfile || aircraftProfile.glideRatio <= 0 || altFt <= 200) return null
  return (altFt * aircraftProfile.glideRatio) / 6076.12
}

/** Filter + sort aerodromes by distance from `centre`, home-airfield-first,
 *  glide-reachable-first. Mirrors web FindDestPanel's `sorted` useMemo. */
export function filterAndSortAerodromes(
  aerodromes:   AerodromeEntry[],
  centre:       FindDestCentre,
  homeIcao:     string | null,
  filters:      FindDestFilters,
  glideRangeNm: number | null,
): AerodromeResult[] {
  const q = (filters.search ?? '').trim().toUpperCase()
  const minRunwayM = filters.minRunwayM ?? 0
  const fuelFilter = filters.fuelFilter ?? 'any'
  const surfFilter = filters.surfFilter ?? 'any'

  return aerodromes
    .filter(a => {
      if (q && !a.icao.includes(q) && !a.name.toUpperCase().includes(q)) return false
      if (minRunwayM > 0 && a.maxRunwayM > 0 && a.maxRunwayM < minRunwayM) return false
      if (fuelFilter === 'avgas' && !hasAvgas(a.fuel)) return false
      if (fuelFilter === 'jet'   && !hasJet(a.fuel))   return false
      if (surfFilter === 'hard'  && !isHard(a.surfaces))  return false
      if (surfFilter === 'grass' && !isGrass(a.surfaces)) return false
      return true
    })
    .map(a => {
      const dist    = distanceNm(centre, a)
      const bearing = bearingDeg(centre, a)
      const withinGlide =
        glideRangeNm !== null &&
        dist <= glideRangeNm &&
        (centre.altFt ?? 0) > a.elevationFt + 200
      return { ...a, dist, bearing, withinGlide }
    })
    .sort((a, b) => {
      if (a.icao === homeIcao && b.icao !== homeIcao) return -1
      if (b.icao === homeIcao && a.icao !== homeIcao) return  1
      if (a.withinGlide && !b.withinGlide) return -1
      if (!a.withinGlide && b.withinGlide) return  1
      return a.dist - b.dist
    })
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function fmtBrg(d: number): string {
  return Math.round(d).toString().padStart(3, '0') + '°'
}
export function fmtDist(nm: number): string {
  return nm < 10 ? `${nm.toFixed(1)} NM` : `${nm.toFixed(0)} NM`
}

/** Build a RouteWaypoint from an aerodrome result — used by "add to route". */
export function aerodromeToWaypoint(a: AerodromeEntry): RouteWaypoint {
  return { lat: a.lat, lng: a.lng, name: a.icao }
}
