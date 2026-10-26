/**
 * Flight-log review in the vertical profile, shared by web and native.
 *
 * A recorded track is turned into a path the vertical-profile engine can
 * analyse like a route (terrain, MSA, airspace, obstacles along what was
 * actually flown) plus the flown altitude per distance along that path.
 *
 * The path is the track simplified (Douglas-Peucker, tolerance in NM), so a
 * 1 Hz recording of a two-hour flight does not become thousands of legs.
 * Every recorded point keeps its own distance on that path: between two kept
 * vertices the recorded distance is scaled onto the simplified leg, so the
 * flown line, the hover readout and the map cursor all agree with the chart's
 * distance axis exactly at the vertices and closely in between.
 *
 * Distances use the same great-circle formula (earth radius 6371.0088 km,
 * km -> NM 0.539957) as buildVirtualRadarProfile, so totals match the chart.
 */

import { GAP_MIN_MS } from './flightLogStats'

export interface FlightLogTrackPoint {
  lat:    number
  lng:    number
  altFt:  number
  spdKts: number
  /** Unix ms */
  ts:     number
}

export interface FlownPoint {
  /** Distance along the simplified path, NM. */
  distNm:    number
  lat:       number
  lng:       number
  /** NaN when the recording has no altitude for this point. */
  altFt:     number
  spdKts:    number
  /** Time since the first recorded point, ms. */
  elapsedMs: number
  /** A recording gap (GPS loss, app suspended) lies between the previous point and this one. */
  gapBefore: boolean
}

export interface FlightLogProfile {
  /** Simplified track: the "route" the vertical profile is built along. */
  path:    { lat: number; lng: number; name?: string }[]
  /** Every usable recorded point, ascending distance. */
  points:  FlownPoint[]
  totalNm: number
}

/** Default simplification tolerance: well under the chart's resolution, far fewer legs than points. */
export const FLOWN_PATH_TOLERANCE_NM = 0.1
/** The path is simplified harder until it has at most this many vertices. */
export const FLOWN_PATH_MAX_VERTICES = 300

const EARTH_RADIUS_KM = 6371.0088
const KM_TO_NM = 0.539957
const toRad = (d: number) => (d * Math.PI) / 180

function gcNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat)
  const dφ = φ2 - φ1, dλ = toRad(b.lng - a.lng)
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * KM_TO_NM
}

/** Douglas-Peucker on a local flat projection (NM), iterative. `keep` is pre-seeded with forced vertices. */
function simplify(xy: [number, number][], tolNm: number, forced: Set<number>): number[] {
  const n = xy.length
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  for (const i of forced) keep[i] = 1
  // Forced vertices split the line into independent stretches.
  const anchors = [...Array(n).keys()].filter((i) => keep[i])
  const stack: [number, number][] = []
  for (let k = 1; k < anchors.length; k++) stack.push([anchors[k - 1], anchors[k]])
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const [ax, ay] = xy[a], [bx, by] = xy[b]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD = -1, maxI = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i]
      let d: number
      if (len2 === 0) d = Math.hypot(px - ax, py - ay)
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      }
      if (d > maxD) { maxD = d; maxI = i }
    }
    if (maxD > tolNm) {
      keep[maxI] = 1
      stack.push([a, maxI], [maxI, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

/**
 * Builds the profile path and flown points for a recorded track. Points
 * without a valid position, and repeats of the same position (parked), are
 * dropped. Returns null when fewer than two distinct positions remain.
 */
export function flightLogProfile(
  track: readonly FlightLogTrackPoint[],
  opts: { toleranceNm?: number; maxVertices?: number; gapMs?: number } = {},
): FlightLogProfile | null {
  const gapMs = opts.gapMs ?? GAP_MIN_MS
  const maxVertices = Math.max(2, opts.maxVertices ?? FLOWN_PATH_MAX_VERTICES)

  // Usable points, consecutive duplicates collapsed (a gap is carried onto the next kept point).
  const pts: FlightLogTrackPoint[] = []
  const gapBefore: boolean[] = []
  let pendingGap = false
  for (let i = 0; i < track.length; i++) {
    const p = track[i]
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) continue
    const prev = pts[pts.length - 1]
    if (prev && p.ts - prev.ts > gapMs) pendingGap = true
    if (prev && gcNm(prev, p) < 1e-4) continue
    pts.push(p)
    gapBefore.push(pts.length > 1 && pendingGap)
    pendingGap = false
  }
  if (pts.length < 2) return null

  // Local flat projection around the track centre for the simplification.
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length
  const kx = 60 * Math.cos(toRad(lat0))
  const xy = pts.map((p): [number, number] => [p.lng * kx, p.lat * 60])
  // Both ends of a gap stay vertices: the gap is then one straight leg, drawn as such.
  const forced = new Set<number>()
  gapBefore.forEach((g, i) => { if (g) { forced.add(i - 1); forced.add(i) } })

  let tol = Math.max(1e-6, opts.toleranceNm ?? FLOWN_PATH_TOLERANCE_NM)
  let kept = simplify(xy, tol, forced)
  for (let guard = 0; kept.length > maxVertices && guard < 20; guard++) {
    tol *= 1.6
    kept = simplify(xy, tol, forced)
  }

  // Recorded cumulative distance, and path cumulative distance at each kept vertex.
  const rawCum = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) rawCum[i] = rawCum[i - 1] + gcNm(pts[i - 1], pts[i])

  const t0 = pts[0].ts
  const points: FlownPoint[] = new Array(pts.length)
  let pathCum = 0
  for (let k = 0; k < kept.length; k++) {
    const a = kept[k]
    const b = kept[k + 1]
    const at = (i: number, d: number) => {
      const p = pts[i]
      points[i] = {
        distNm: d, lat: p.lat, lng: p.lng,
        altFt: Number.isFinite(p.altFt) ? p.altFt : NaN,
        spdKts: Number.isFinite(p.spdKts) ? p.spdKts : NaN,
        elapsedMs: p.ts - t0, gapBefore: gapBefore[i],
      }
    }
    at(a, pathCum)
    if (b == null) break
    const legNm = gcNm(pts[a], pts[b])
    const rawSpan = rawCum[b] - rawCum[a]
    for (let i = a + 1; i < b; i++) {
      at(i, pathCum + (rawSpan > 0 ? ((rawCum[i] - rawCum[a]) / rawSpan) * legNm : 0))
    }
    pathCum += legNm
  }

  const path = kept.map((i) => ({ lat: pts[i].lat, lng: pts[i].lng }))
  return { path, points, totalNm: pathCum }
}

/** Index of the last point at or before `distNm` (binary search; 0 when before the start). */
function indexAtOrBefore(points: readonly FlownPoint[], distNm: number): number {
  let lo = 0, hi = points.length - 1
  if (hi < 0 || distNm <= points[0].distNm) return 0
  if (distNm >= points[hi].distNm) return hi
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].distNm <= distNm) lo = mid
    else hi = mid
  }
  return lo
}

/** Index of the recorded point nearest to `distNm` (0 for an empty list). */
export function flownIndexAt(points: readonly FlownPoint[], distNm: number): number {
  const i = indexAtOrBefore(points, distNm)
  const a = points[i], b = points[i + 1]
  if (!a || !b) return i
  return distNm - a.distNm <= b.distNm - distNm ? i : i + 1
}

/** Recorded point nearest to `distNm`. */
export function flownPointAt(points: readonly FlownPoint[], distNm: number): FlownPoint | null {
  return points.length === 0 ? null : points[flownIndexAt(points, distNm)]
}

/**
 * Flown altitude at `distNm`, linearly interpolated; the last known altitude
 * when a point has none. NaN only when nothing before or after has one.
 */
export function flownAltitudeAt(points: readonly FlownPoint[], distNm: number): number {
  if (points.length === 0) return NaN
  const i = indexAtOrBefore(points, distNm)
  const a = points[i], b = points[i + 1]
  if (b && Number.isFinite(a.altFt) && Number.isFinite(b.altFt) && b.distNm > a.distNm) {
    const t = Math.max(0, Math.min(1, (distNm - a.distNm) / (b.distNm - a.distNm)))
    return a.altFt + t * (b.altFt - a.altFt)
  }
  for (let k = i; k >= 0; k--) if (Number.isFinite(points[k].altFt)) return points[k].altFt
  for (let k = i + 1; k < points.length; k++) if (Number.isFinite(points[k].altFt)) return points[k].altFt
  return NaN
}

/** Map position at `distNm`, interpolated between the recorded points. */
export function flownCoordinateAt(points: readonly FlownPoint[], distNm: number): { lat: number; lng: number } | null {
  if (points.length === 0) return null
  const i = indexAtOrBefore(points, distNm)
  const a = points[i], b = points[i + 1]
  if (!b || b.distNm <= a.distNm) return { lat: a.lat, lng: a.lng }
  const t = Math.max(0, Math.min(1, (distNm - a.distNm) / (b.distNm - a.distNm)))
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) }
}

/**
 * The flown line split for drawing: `runs` are continuous stretches with an
 * altitude, `gaps` join the two ends of each recording gap (no data in
 * between, so it must not look like a flown line).
 */
export function flownLineParts(points: readonly FlownPoint[]): {
  runs: { distNm: number; altFt: number }[][]
  gaps: [{ distNm: number; altFt: number }, { distNm: number; altFt: number }][]
} {
  const runs: { distNm: number; altFt: number }[][] = []
  const gaps: [{ distNm: number; altFt: number }, { distNm: number; altFt: number }][] = []
  let cur: { distNm: number; altFt: number }[] = []
  let last: { distNm: number; altFt: number } | null = null
  let noAlt = false
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = [] }
  for (const p of points) {
    // A stretch without altitude is a gap too: nothing is known about how it was flown.
    if (!Number.isFinite(p.altFt)) { noAlt = true; continue }
    const q = { distNm: p.distNm, altFt: p.altFt }
    if ((p.gapBefore || noAlt) && last) {
      flush()
      gaps.push([last, q])
    }
    cur.push(q)
    last = q
    noAlt = false
  }
  flush()
  return { runs, gaps }
}

/** "1 h 05 min 12 s" / "12 min 30 s" / "45 s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min ${String(sec).padStart(2, '0')} s`
  if (m > 0) return `${m} min ${String(sec).padStart(2, '0')} s`
  return `${sec} s`
}
