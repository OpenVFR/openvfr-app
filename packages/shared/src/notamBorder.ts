/**
 * notamBorder.ts -- follow a country / FIR outline between two vertices.
 *
 * NOTAM texts say "A - ALONG THE STATE BORDER TO B": the edge between A and B
 * is the border, not a straight line. Given outline rings (country outlines
 * as [lon, lat] polygons) this walks the outline from A to B:
 *
 *   1. snap A and B onto the same ring, within SNAP_NM (onto edges as well as
 *      vertices; the stated coordinates are rounded and the outline is
 *      simplified). The ring is chosen by the endpoints lying on it, not by
 *      its size;
 *   2. walk the shorter way round the ring;
 *   3. refuse when the longer way is less than twice the shorter: the text
 *      does not say which side, and a wrong guess draws the wrong area. The
 *      caller then keeps the straight edge and calls the area approximate.
 */

/** Endpoints must lie this close to the outline (NM). */
export const SNAP_NM = 2

export interface BorderRing {
  /** Closed [lon, lat] polyline (last point repeats the first). */
  pts: number[][]
  bbox: [number, number, number, number]
}

/** Outlines as stored by the api: { code: MultiPolygon coordinates }. */
export type OutlineSet = Record<string, number[][][][]>

export function prepareBorderRings(outlines: OutlineSet): BorderRing[] {
  const out: BorderRing[] = []
  for (const mp of Object.values(outlines)) {
    for (const poly of mp) {
      for (const ring of poly) {
        if (ring.length < 4) continue
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of ring) {
          minX = Math.min(minX, p[0]!); maxX = Math.max(maxX, p[0]!)
          minY = Math.min(minY, p[1]!); maxY = Math.max(maxY, p[1]!)
        }
        out.push({ pts: ring, bbox: [minX, minY, maxX, maxY] })
      }
    }
  }
  return out
}

interface Snap { dist: number; edge: number; t: number }

/** Planar distances in NM around latitude `lat0`. */
function snapToRing(p: number[], ring: BorderRing, kx: number): Snap | null {
  const [minX, minY, maxX, maxY] = ring.bbox
  const padLat = SNAP_NM / 60, padLon = SNAP_NM / 60 / kx
  if (p[0]! < minX - padLon || p[0]! > maxX + padLon || p[1]! < minY - padLat || p[1]! > maxY + padLat) return null
  let best: Snap | null = null
  const n = ring.pts.length - 1
  for (let k = 0; k < n; k++) {
    const a = ring.pts[k]!, b = ring.pts[k + 1]!
    const ax = a[0]! * kx * 60, ay = a[1]! * 60
    const dx = b[0]! * kx * 60 - ax, dy = b[1]! * 60 - ay
    const px = p[0]! * kx * 60 - ax, py = p[1]! * 60 - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
    const dist = Math.hypot(px - t * dx, py - t * dy)
    if (!best || dist < best.dist) best = { dist, edge: k, t }
  }
  return best
}

/**
 * Vertices ([lon, lat], exclusive of a and b) of the outline between a and b,
 * the shorter way round; null when no ring carries both within SNAP_NM or
 * when the two ways are within a factor of 2.
 */
export function followOutline(a: number[], b: number[], rings: readonly BorderRing[]): number[][] | null {
  const kx = Math.cos(((a[1]! + b[1]!) / 2) * Math.PI / 180)
  let best: { ring: BorderRing; sa: Snap; sb: Snap } | null = null
  for (const ring of rings) {
    const sa = snapToRing(a, ring, kx)
    if (!sa || sa.dist > SNAP_NM) continue
    const sb = snapToRing(b, ring, kx)
    if (!sb || sb.dist > SNAP_NM) continue
    if (!best || sa.dist + sb.dist < best.sa.dist + best.sb.dist) best = { ring, sa, sb }
  }
  if (!best) return null
  const { ring, sa, sb } = best
  const n = ring.pts.length - 1
  // Distance along the ring from its first vertex to every vertex, and to a snap.
  const L: number[] = [0]
  for (let k = 0; k < n; k++) {
    const p = ring.pts[k]!, q = ring.pts[k + 1]!
    L.push(L[k]! + Math.hypot((q[0]! - p[0]!) * kx * 60, (q[1]! - p[1]!) * 60))
  }
  const total = L[n]!
  if (total === 0) return null
  const at = (s: Snap) => L[s.edge]! + s.t * (L[s.edge + 1]! - L[s.edge]!)
  const sA = at(sa), sB = at(sb)
  const fwd = (sB - sA + total) % total
  const bwd = total - fwd
  const [shorter, longer] = fwd <= bwd ? [fwd, bwd] : [bwd, fwd]
  if (longer < 2 * shorter) return null
  const forward = fwd <= bwd
  const between: { off: number; p: number[] }[] = []
  for (let m = 0; m < n; m++) {
    const off = forward ? (L[m]! - sA + total) % total : (sA - L[m]! + total) % total
    if (off > 1e-9 && off < shorter - 1e-9) between.push({ off, p: ring.pts[m]! })
  }
  return between.sort((x, y) => x.off - y.off).map(x => x.p)
}
