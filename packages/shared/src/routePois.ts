/**
 * Aerodromes, reporting points and navaids along a route, for the Virtual
 * Radar / vertical profile. Each kind has its own distance from the track
 * inside which it is drawn (a busy towered field is relevant further out than
 * a reporting point), instead of one corridor for everything.
 *
 * Distances follow the reference planner's per-type thresholds
 * (VirtualRadarSpotEntityLayer: aerodromes 5 / 3 / 0 NM by traffic type,
 * reporting points 2 NM), adapted to our data: we have no traffic-type
 * field, so towered aerodromes stand in for the busy ones.
 */

import length from '@turf/length'
import nearestPointOnLine from '@turf/nearest-point-on-line'
import { lineString } from '@turf/helpers'
import type { Feature, FeatureCollection, Point } from 'geojson'
import type { RouteWaypoint } from './types'

export type RoutePoiKind = 'aerodrome' | 'reporting' | 'navaid'

export type RoutePoi = {
  kind: RoutePoiKind
  /** NM along the route where the point projects onto the route line. */
  distNm: number
  /** Distance off the route line (NM). */
  lateralNm: number
  /** ICAO / reporting point / navaid identifier or name (what the label shows). */
  label: string
  /** Aerodrome: AD | HP | AH. Reporting point: MRP | RP | ENR | ICAO. Navaid: VOR | NDB. */
  subtype: string
  towered: boolean
  /** Surveyed elevation (ft AMSL) when the data has one. */
  elevationFt: number | null
}

/** Draw-distance (NM either side of the track) for one point. */
export function poiCorridorNm(kind: RoutePoiKind, props: Record<string, unknown>): number {
  if (kind === 'aerodrome') {
    if (props.type === 'HP') return 1            // helipads: only right on the track
    return props.towered === true ? 5 : 3
  }
  if (kind === 'reporting') return 2
  return 3                                        // navaids
}

const NM_PER_KM = 0.539957

function collect(
  line: ReturnType<typeof lineString>,
  totalNm: number,
  bbox: [number, number, number, number],
  fc: FeatureCollection | null | undefined,
  kind: RoutePoiKind,
  out: RoutePoi[],
): void {
  for (const f of fc?.features ?? []) {
    if (f.geometry?.type !== 'Point') continue
    const [lng, lat] = (f.geometry as Point).coordinates
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue
    const props = (f.properties ?? {}) as Record<string, unknown>
    const snapped = nearestPointOnLine(line, f as Feature<Point>, { units: 'kilometers' })
    const lateralNm = (snapped.properties.dist ?? Infinity) * NM_PER_KM
    if (lateralNm > poiCorridorNm(kind, props)) continue
    const distNm = (snapped.properties.location ?? 0) * NM_PER_KM
    if (distNm < 0 || distNm > totalNm) continue
    const label = kind === 'aerodrome'
      ? String(props.icao || props.name || '')
      : kind === 'navaid'
        ? String(props.id || props.name || '')
        : String(props.name || props.id || '')
    const subtype = String(props.type ?? props.wp_type ?? props.kind ?? '')
    const elev = Number(props.elevation_ft)
    out.push({
      kind, distNm: Math.round(distNm * 10) / 10, lateralNm: Math.round(lateralNm * 10) / 10,
      label, subtype, towered: props.towered === true, elevationFt: Number.isFinite(elev) ? elev : null,
    })
  }
}

/** Every aerodrome / reporting point / navaid within its own corridor of the route. */
export function collectRoutePois(
  waypoints: RouteWaypoint[],
  sets: { aerodromes?: FeatureCollection | null; reporting?: FeatureCollection | null; navaids?: FeatureCollection | null },
): RoutePoi[] {
  if (waypoints.length < 2) return []
  const line = lineString(waypoints.map((w) => [w.lng, w.lat]))
  const totalNm = length(line, { units: 'kilometers' }) * NM_PER_KM
  // Widest corridor + a little slack, as a cheap reject box for the whole file.
  const lngs = waypoints.map((w) => w.lng), lats = waypoints.map((w) => w.lat)
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const latPad = 5.5 / 60
  const lngPad = 5.5 / (60 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)))
  const bbox: [number, number, number, number] = [Math.min(...lngs) - lngPad, Math.min(...lats) - latPad, Math.max(...lngs) + lngPad, Math.max(...lats) + latPad]
  const out: RoutePoi[] = []
  collect(line, totalNm, bbox, sets.aerodromes, 'aerodrome', out)
  collect(line, totalNm, bbox, sets.reporting, 'reporting', out)
  collect(line, totalNm, bbox, sets.navaids, 'navaid', out)
  // Departure/arrival aerodromes are the route's own ends, already shown by
  // the waypoint lines; drop points that sit on a route point's name.
  const names = new Set(waypoints.map((w) => (w.name ?? '').toUpperCase()).filter(Boolean))
  return out.filter((p) => !(p.kind === 'aerodrome' && names.has(p.label.toUpperCase())))
    .sort((a, b) => a.distNm - b.distNm)
}

/** Ground-level position helper, so callers do not repeat the rule: surveyed
 *  elevation when known, else the terrain sample, never below sea level. */
export function poiBaseFt(poi: RoutePoi, terrainFt: number): number {
  return Math.max(0, poi.elevationFt ?? terrainFt)
}
