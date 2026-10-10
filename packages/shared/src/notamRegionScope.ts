/**
 * notamRegionScope.ts -- which regional (non-aerodrome) NOTAMs a client
 * actually needs, given the countries it is working in.
 *
 * The API server ingests NOTAMs for a much wider area than any one pilot
 * needs (the military classification is kept for all of Europe, see
 * apps/api/src/notam.ts). Shipping all of that to every client meant
 * Spanish and Greek military notices on a Swedish pilot's map, a larger
 * payload on every 5-minute poll, and per-tick warning/airspace matching
 * over NOTAMs nobody could fly into. Instead the client sends the set of
 * region codes it cares about (`GET /api/notam/regional?regions=se,dk`)
 * and the server filters with notamInRegions() below.
 *
 * The region set must never be just "the selected country": a route that
 * leaves it, or a GPS position across the border, needs the neighbouring
 * country's NOTAMs too. notamRegionsFor() builds the set from the selected
 * region(s) plus every region a route leg or the current position touches.
 *
 * Every test here errs toward inclusion. Region bounding boxes are rough
 * and overlap near borders, so a NOTAM near a border is usually kept for
 * both neighbours -- the safe direction for flight-relevant data.
 */
import { EUROPEAN_REGIONS, type Region } from './regions'
import { REGION_ICAO_PREFIXES } from './notamRelevance'
import {
  circleIntersectsBbox, pointNearBbox, polygonNearBbox,
  type CoverageBbox, type NotamPolygonGeometry,
} from './notamCoverageArea'

export interface LatLng { lat: number; lng: number }

/** Region code -> region, for validating client-supplied codes. */
const REGION_BY_CODE: ReadonlyMap<string, Region> = new Map(EUROPEAN_REGIONS.map(r => [r.code, r]))

export function isKnownRegion(code: string): boolean {
  return REGION_BY_CODE.has(code)
}

/** Margin (degrees) around a region bbox for point/polygon geometry with no radius. */
export const REGION_MARGIN_DEG = 0.75

/**
 * Radii above this are treated as "no usable radius". Upstream uses 999 NM
 * as the whole-FIR sentinel; a circle that large would intersect every
 * region and defeat the filter.
 */
const MAX_SANE_RADIUS_NM = 100

/** Spacing (NM) of the samples taken along each route leg. */
const LEG_SAMPLE_NM = 10

function toBbox(r: Region): CoverageBbox {
  const [south, west, north, east] = r.bbox
  return { south, west, north, east }
}

function inBbox(p: LatLng, r: Region): boolean {
  const [s, w, n, e] = r.bbox
  return p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e
}

/**
 * Points every LEG_SAMPLE_NM along each leg (straight lat/lon
 * interpolation: plenty accurate for "which countries does this leg pass
 * over" at these leg lengths). Catches a country the route crosses without
 * having a waypoint in it, e.g. a Sweden -> Germany leg over Denmark.
 */
export function sampleRoute(points: LatLng[]): LatLng[] {
  if (points.length < 2) return points.slice()
  const out: LatLng[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const dLatNm = (b.lat - a.lat) * 60
    const dLngNm = (b.lng - a.lng) * 60 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
    const steps = Math.max(1, Math.ceil(Math.hypot(dLatNm, dLngNm) / LEG_SAMPLE_NM))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t })
    }
  }
  return out
}

/**
 * Sorted, de-duplicated region codes a client should request NOTAMs for:
 * the selected region(s), plus every region containing a sampled point of
 * the route, plus the region containing the current position. Unknown
 * selected codes are dropped. Sorted so the result can be used directly as
 * a stable cache / effect key.
 */
export function notamRegionsFor(opts: {
  selected: string[]
  route?: LatLng[]
  position?: LatLng | null
}): string[] {
  const out = new Set<string>()
  for (const code of opts.selected) if (REGION_BY_CODE.has(code)) out.add(code)
  const points = sampleRoute(opts.route ?? [])
  if (opts.position) points.push(opts.position)
  for (const r of EUROPEAN_REGIONS) {
    if (out.has(r.code)) continue
    if (points.some(p => inBbox(p, r))) out.add(r.code)
  }
  return [...out].sort()
}

/** Comma-separated, sorted region list for the `regions` query parameter. */
export function regionsParam(regions: string[]): string {
  return [...new Set(regions)].sort().join(',')
}

/**
 * Parses a `regions` query value. Returns null when the parameter is
 * absent/empty (caller decides the fallback), or `{ error }` naming the
 * first unknown code.
 */
export function parseRegionsParam(raw: string | undefined | null): string[] | null | { error: string } {
  if (raw === undefined || raw === null || raw.trim() === '') return null
  const codes = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (codes.length > EUROPEAN_REGIONS.length) return { error: 'Too many regions.' }
  for (const c of codes) if (!REGION_BY_CODE.has(c)) return { error: `Unknown region: ${c.slice(0, 8)}` }
  return [...new Set(codes)]
}

/** The subset of NotamItem this module reads. */
export interface RegionScopeInput {
  icaoLocation?: string | null
  affectedFir?: string | null
  polygon?: NotamPolygonGeometry | null
  lat: number | null
  lon: number | null
  radiusNm?: number | null
}

/** Precomputed lookup for a region set -- build once per request, not per NOTAM. */
export interface RegionScope {
  prefixes: Set<string>
  bboxes: CoverageBbox[]
}

export function regionScope(regions: string[]): RegionScope {
  const prefixes = new Set<string>()
  const bboxes: CoverageBbox[] = []
  for (const code of regions) {
    const r = REGION_BY_CODE.get(code)
    if (!r) continue
    bboxes.push(toBbox(r))
    for (const p of REGION_ICAO_PREFIXES[code] ?? []) prefixes.add(p)
  }
  return { prefixes, bboxes }
}

/**
 * True when a NOTAM is relevant to the region set. Kept if EITHER:
 *  - it is filed in one of the regions (ICAO prefix of its FIR or location
 *    indicator), wherever its geometry is; or
 *  - its own geometry (polygon, sane-radius circle, or bare point) reaches
 *    into one of the regions' bounding boxes -- the cross-border case, e.g.
 *    a German-filed exercise area over the southern Baltic for a Swedish
 *    pilot.
 * A NOTAM with neither a recognisable filing location nor any geometry is
 * kept: nothing says it is irrelevant, and dropping it would be silent.
 */
export function notamInRegions(n: RegionScopeInput, scope: RegionScope): boolean {
  const filed = [n.affectedFir, n.icaoLocation]
    .filter((s): s is string => typeof s === 'string' && s.length >= 2)
    .map(s => s.slice(0, 2).toUpperCase())
  if (filed.some(p => scope.prefixes.has(p))) return true

  if (n.polygon) return scope.bboxes.some(b => polygonNearBbox(n.polygon!, REGION_MARGIN_DEG, b))

  if (n.lat !== null && n.lon !== null) {
    const r = n.radiusNm
    if (typeof r === 'number' && Number.isFinite(r) && r > 0 && r <= MAX_SANE_RADIUS_NM) {
      return scope.bboxes.some(b => circleIntersectsBbox(n.lat!, n.lon!, r, b))
    }
    return scope.bboxes.some(b => pointNearBbox(n.lat!, n.lon!, REGION_MARGIN_DEG, b))
  }

  return filed.length === 0
}

export function filterNotamsToRegions<T extends RegionScopeInput>(notams: T[], regions: string[]): T[] {
  const scope = regionScope(regions)
  return notams.filter(n => notamInRegions(n, scope))
}
