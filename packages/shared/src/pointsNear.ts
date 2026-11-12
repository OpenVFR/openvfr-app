/**
 * pointsNear — candidate route points (aerodromes, navaids, reporting points,
 * named landmarks) near a position, along a leg, or just outside a piece of
 * airspace, each with the identifier a route accepts and the controlled
 * airspace above it. For planning a way around something ("which points are
 * near the edge of the TMA, below its floor?").
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { distanceNm, bearingDeg, type RouteWaypoint } from './routeCalc'
import { nearestRoutePoint } from './notamRouteFilter'
import { routeIdentifier, type IndexedPoint, type PointIndex } from './routeIdentifiers'
import { airspaceDisplayClass } from './airspaceColors'

type FC = GeoJSON.FeatureCollection

/** Classes that need a clearance for VFR. */
const CLEARANCE = new Set(['A', 'B', 'C', 'D'])

export type PointKind = IndexedPoint['kind']

export interface NearPoint {
  /** What to write in a route. */
  identifier: string
  kind: PointKind
  /** Navaid name, landmark kind ('church'...), aerodrome or reporting point name. */
  detail: string
  lat: number
  lng: number
  /** Distance from the centre, the leg, or the airspace edge, NM. */
  distNm: number
  /** Where along the leg (NM from its start) and on which side, for leg searches. */
  alongNm?: number
  side?: 'left' | 'right'
  /** Distance outside (positive) or inside (negative) the airspace, for airspace searches. */
  edgeNm?: number
  /** Lowest controlled airspace above the point: name, class and floor (ft). null = none. */
  controlledAbove: { name: string; cls: string; floorFt: number } | null
}

export function allPoints(idx: PointIndex): IndexedPoint[] {
  const out: IndexedPoint[] = [...idx.aerodromes.values()]
  for (const m of [idx.navaids, idx.waypoints, idx.landmarks]) for (const l of m.values()) out.push(...l)
  return out
}

/** Rings of every polygon in a feature (outer and holes). */
function rings(f: GeoJSON.Feature): number[][][] {
  const g = f.geometry
  if (!g) return []
  if (g.type === 'Polygon') return g.coordinates
  if (g.type === 'MultiPolygon') return g.coordinates.flat()
  return []
}

function controlledAbove(p: { lat: number; lng: number }, airspace: FC | null | undefined): NearPoint['controlledAbove'] {
  let best: NearPoint['controlledAbove'] = null
  for (const f of airspace?.features ?? []) {
    const pr = f.properties ?? {}
    // The data's class 'D' bucket also holds danger areas: read it as the display class.
    const cls = airspaceDisplayClass(String(pr['class'] ?? ''), String(pr['type'] ?? ''))
    if (!CLEARANCE.has(cls) || !f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue
    const floor = Number(pr['lower_ft'] ?? 0)
    if (best && floor >= best.floorFt) continue
    if (booleanPointInPolygon([p.lng, p.lat], f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)) {
      best = { name: String(pr['name'] ?? ''), cls, floorFt: Math.round(floor) }
    }
  }
  return best
}

/** Charted points (aerodromes, navaids, reporting points) rank as if this much closer than a landmark. */
const LANDMARK_RANK_NM = 3

/**
 * Nearest first, charted points before landmarks: there are thousands of
 * named buildings, and a reporting point or aerodrome is what a pilot and
 * ATC know. Landmarks fill at most a third of the list unless asked for alone.
 */
function finish(list: (Omit<NearPoint, 'controlledAbove'> & { p: IndexedPoint })[], airspace: FC | null | undefined, limit: number, onlyLandmarks: boolean): NearPoint[] {
  const rank = (x: { distNm: number; kind: PointKind }) => x.distNm + (x.kind === 'landmark' ? LANDMARK_RANK_NM : 0)
  const maxLandmarks = onlyLandmarks ? limit : Math.max(1, Math.ceil(limit / 3))
  let lm = 0
  const picked = list.sort((a, b) => rank(a) - rank(b)).filter(x => x.kind !== 'landmark' || lm++ < maxLandmarks).slice(0, limit)
  return picked.map(({ p: _p, ...x }) => ({ ...x, controlledAbove: controlledAbove(x, airspace) }))
}
const onlyLm = (kinds?: readonly PointKind[]) => !!kinds && kinds.length > 0 && kinds.every(k => k === 'landmark')

const base = (p: IndexedPoint) => ({
  p, identifier: routeIdentifier(p), kind: p.kind, lat: p.lat, lng: p.lng,
  detail: p.kind === 'waypoint' ? (p.aerodrome ? `reporting point of ${p.aerodrome}` : 'reporting point') : p.name,
})

export function pointsNearPosition(
  pts: readonly IndexedPoint[], centre: { lat: number; lng: number }, radiusNm: number,
  opts: { kinds?: readonly PointKind[]; airspace?: FC | null; limit?: number } = {},
): NearPoint[] {
  const out = pts.filter(p => !opts.kinds || opts.kinds.includes(p.kind))
    .map(p => ({ ...base(p), distNm: distanceNm(centre, p) }))
    .filter(x => x.distNm <= radiusNm)
  return finish(out, opts.airspace, opts.limit ?? 15, onlyLm(opts.kinds))
}

export function pointsNearLeg(
  pts: readonly IndexedPoint[], a: RouteWaypoint, b: RouteWaypoint, corridorNm: number,
  opts: { kinds?: readonly PointKind[]; airspace?: FC | null; limit?: number } = {},
): NearPoint[] {
  const len = distanceNm(a, b)
  const brg = bearingDeg(a, b)
  const out = pts.filter(p => !opts.kinds || opts.kinds.includes(p.kind)).flatMap(p => {
    const pos = nearestRoutePoint(p, [a, b])
    if (pos.lateralNm > corridorNm || pos.alongNm <= 0.01 && distanceNm(a, p) > corridorNm || pos.alongNm >= len - 0.01 && distanceNm(b, p) > corridorNm) return []
    const rel = ((bearingDeg(a, p) - brg) % 360 + 360) % 360
    return [{ ...base(p), distNm: pos.lateralNm, alongNm: Math.round(pos.alongNm * 10) / 10, side: (rel < 180 ? 'right' : 'left') as 'left' | 'right' }]
  })
  return finish(out, opts.airspace, opts.limit ?? 15, onlyLm(opts.kinds))
}

/**
 * Points near the edge of an airspace (all features named `name`), outside
 * it unless `inside`, within `withinNm` of the boundary. With `near` (a leg),
 * only points within `nearNm` of it.
 */
export function pointsNearAirspaceEdge(
  pts: readonly IndexedPoint[], airspace: FC, name: string, withinNm: number,
  opts: { kinds?: readonly PointKind[]; inside?: boolean; near?: [RouteWaypoint, RouteWaypoint]; nearNm?: number; limit?: number } = {},
): { matched: string[]; points: NearPoint[] } {
  const key = name.trim().toUpperCase()
  const named = airspace.features.filter(f => String(f.properties?.['name'] ?? '').toUpperCase() === key)
  const feats = named.length ? named : airspace.features.filter(f => String(f.properties?.['name'] ?? '').toUpperCase().includes(key))
  const matched = [...new Set(feats.map(f => String(f.properties?.['name'] ?? '')))]
  if (matched.length !== 1) return { matched, points: [] }
  const ringLines = feats.flatMap(rings).map(r => r.map(([lng, lat]) => ({ lat: lat!, lng: lng! })))
  const out = pts.filter(p => !opts.kinds || opts.kinds.includes(p.kind)).flatMap(p => {
    if (opts.near && nearestRoutePoint(p, opts.near).lateralNm > (opts.nearNm ?? 15)) return []
    const inside = feats.some(f => booleanPointInPolygon([p.lng, p.lat], f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>))
    if (inside !== !!opts.inside) return []
    let edge = Infinity
    for (const r of ringLines) edge = Math.min(edge, nearestRoutePoint(p, r).lateralNm)
    if (edge > withinNm) return []
    return [{ ...base(p), distNm: edge, edgeNm: Math.round((inside ? -edge : edge) * 10) / 10 }]
  })
  return { matched, points: finish(out, airspace, opts.limit ?? 15, onlyLm(opts.kinds)) }
}
