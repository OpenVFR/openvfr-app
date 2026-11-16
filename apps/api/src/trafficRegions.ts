/**
 * trafficRegions.ts -- region scoping for the traffic feeds (pure, no env, no I/O).
 *
 * The OpenSky poll is ONE Europe-wide call (one rectangle costs 4 credits no
 * matter how big, so there is nothing to save by polling less area). The cost
 * is the payload: thousands of state vectors per cycle. Each client therefore
 * names the regions it works in (`?regions=se,dk`, same codes and same
 * selection logic as /api/notam/regional: selected countries + route + own
 * position) and gets only the targets inside those regions' boxes (+ margin).
 *
 * Boxes are the rough region bboxes from @open-vfr/shared/regions and overlap
 * near borders, which errs toward inclusion (safe for traffic awareness).
 */
import { DEFAULT_REGION_CODES, EUROPEAN_REGIONS } from '@open-vfr/shared/regions'
import type { TrafficBatch, TrafficState } from './traffic'

/** [latMin, lonMin, latMax, lonMax] */
export type Box = readonly [number, number, number, number]

/** Margin (degrees) around each region box: traffic just across the border still matters. */
export const REGION_MARGIN_DEG = 0.5

const BOX_BY_CODE = new Map<string, Box>(
  EUROPEAN_REGIONS.map(r => {
    const [s, w, n, e] = r.bbox
    return [r.code, [s - REGION_MARGIN_DEG, w - REGION_MARGIN_DEG, n + REGION_MARGIN_DEG, e + REGION_MARGIN_DEG] as Box]
  }),
)

/** Boxes of every known region: post-poll prune of the Europe-wide batch (dead space between countries). */
export const ALL_BOXES: readonly Box[] = [...BOX_BY_CODE.values()]

/** Boxes for the known codes in `codes` (unknown ones ignored). */
export function boxesFor(codes: Iterable<string>): Box[] {
  const out: Box[] = []
  for (const c of codes) { const b = BOX_BY_CODE.get(c); if (b) out.push(b) }
  return out
}

export function inAnyBox(lat: number | null, lon: number | null, boxes: readonly Box[]): boolean {
  if (lat == null || lon == null) return false
  for (const [s, w, n, e] of boxes) if (lat >= s && lat <= n && lon >= w && lon <= e) return true
  return false
}

/** The batch reduced to targets inside the boxes. Same object when nothing is dropped. */
export function filterBatch(batch: TrafficBatch, boxes: readonly Box[]): TrafficBatch {
  const states = batch.states.filter((s: TrafficState) => inAnyBox(s.lat, s.lon, boxes))
  return states.length === batch.states.length ? batch : { ...batch, states }
}

/** Canonical key of a region set (sorted, unique, known codes only). */
export function regionKey(codes: Iterable<string>): string {
  return [...new Set([...codes].filter(c => BOX_BY_CODE.has(c)))].sort().join(',')
}

/** Smallest box around all of `boxes`, [latMin, lonMin, latMax, lonMax]. */
export function unionBox(boxes: readonly Box[]): Box {
  return [
    Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3])),
  ]
}

/** Default OpenSky poll area: every known region (Iceland to Cyprus). One call, 4 credits whatever the size. */
export const EUROPE_BOX: Box = unionBox(ALL_BOXES)

/** A validated region set, computed once and shared: key for maps, codes for the OGN filter, boxes for filtering. */
export interface RegionScope {
  readonly key: string
  readonly codes: readonly string[]
  readonly boxes: readonly Box[]
}

const _scopes = new Map<string, RegionScope>()
const MAX_CACHED_SCOPES = 512

/**
 * Scope for a client's `regions` list: unknown codes dropped, empty/absent =
 * the default region (clients predating the parameter only had its data).
 * Same set -> same object.
 */
export function makeScope(regions?: readonly string[] | null): RegionScope {
  let key = regionKey(regions ?? [])
  if (key === '') key = regionKey(DEFAULT_REGION_CODES)
  const hit = _scopes.get(key)
  if (hit) return hit
  const codes = key.split(',')
  const scope: RegionScope = { key, codes, boxes: boxesFor(codes) }
  if (_scopes.size >= MAX_CACHED_SCOPES) _scopes.clear()
  _scopes.set(key, scope)
  return scope
}
