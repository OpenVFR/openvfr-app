/**
 * subAreas — drop sub-areas that are fully covered by their parent airspace.
 *
 * Danger/restricted areas are often published as a parent plus lettered
 * sub-areas that tile it (ESR121 REVINGE = ESR121A + ESR121B, same limits).
 * Warning on both the parent and the child shows the same hazard twice, so the
 * alert hooks drop the child when a same-limits parent covers it.
 */

import { pointInPolygon } from './airspaceGeometry'

type Geom = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] }
export type SubAreaCandidate = {
  name: string; cls: string; type: string; lower_ft: number; upper_ft: number; geometry: Geom
}

/** "ESR121B REVINGE" -> { base: "ESR121 REVINGE", sub: "B" }; sub '' when not a sub-area. */
function split(name: string): { base: string; sub: string } {
  const m = /^([A-Z]+\d+)([A-Z]?)(\s.*)?$/.exec(name)
  return m ? { base: m[1] + (m[3] ?? ''), sub: m[2] } : { base: name, sub: '' }
}

function outerRings(g: Geom): number[][][] {
  return g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0])
}

/** Every vertex of the child, nudged 5% toward the child's mean vertex (so
 *  shared boundary edges don't fail the test), lies inside the parent. */
function covers(parent: Geom, child: Geom): boolean {
  for (const ring of outerRings(child)) {
    const pts = ring.slice(0, -1)
    if (pts.length === 0) return false
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
    for (const [x, y] of pts) {
      if (!pointInPolygon(y + (cy - y) * 0.05, x + (cx - x) * 0.05, parent)) return false
    }
  }
  return true
}

export function dropCoveredSubAreas<T extends SubAreaCandidate>(features: T[]): T[] {
  const parents = new Map<string, T[]>()
  for (const f of features) {
    const { base, sub } = split(f.name)
    if (sub !== '') continue
    const k = `${base}::${f.cls}::${f.type}::${f.lower_ft}-${f.upper_ft}`
    const list = parents.get(k)
    if (list) list.push(f); else parents.set(k, [f])
  }
  return features.filter((f) => {
    const { base, sub } = split(f.name)
    if (sub === '') return true
    const ps = parents.get(`${base}::${f.cls}::${f.type}::${f.lower_ft}-${f.upper_ft}`)
    return !ps?.some((p) => covers(p.geometry, f.geometry))
  })
}
