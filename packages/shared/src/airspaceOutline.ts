/**
 * airspaceOutline — merge the airspace bands of the vertical profile into one
 * outline per visual style.
 *
 * Each band is a rectangle in (distance along route, altitude) space. Sectors
 * of the same kind often overlap or touch — e.g. a TMA with a 2500 ft floor
 * for a stretch, then a 1500 ft floor, then 2500 ft again. Drawn as separate
 * rectangles, the 2500 ft floor line shows up inside the 1500 ft area. The
 * union of same-style rectangles is a single rectilinear shape whose outline
 * follows the real floor/ceiling as a stepped curve, so only its boundary is
 * drawn.
 *
 * Bands with different fill/border colours (CTR vs TMA, restricted vs class
 * C, ...) are kept as separate shapes.
 */

export interface OutlineBand {
  lower_ft: number
  upper_ft: number
  entryNm:  number
  exitNm:   number
  fill:     string
  border:   string
}

export interface OutlineShape {
  fill:   string
  border: string
  /** Closed loops in (distNm, altFt); several loops = outer boundary + holes
   *  or separate islands. Fill with the even-odd rule. */
  loops:  [number, number][][]
}

type Rect = { x1: number; x2: number; y1: number; y2: number }

/** Boundary loops of the union of axis-aligned rectangles. */
export function unionRectLoops(rects: Rect[]): [number, number][][] {
  if (rects.length === 0) return []
  const xs = [...new Set(rects.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b)
  const ys = [...new Set(rects.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b)
  const nx = xs.length - 1, ny = ys.length - 1
  if (nx < 1 || ny < 1) return []
  const xi = new Map(xs.map((v, i) => [v, i]))
  const yi = new Map(ys.map((v, i) => [v, i]))

  // filled[i][j]: the grid cell [xs[i],xs[i+1]] x [ys[j],ys[j+1]] is covered
  const filled: boolean[][] = Array.from({ length: nx }, () => new Array<boolean>(ny).fill(false))
  for (const r of rects) {
    for (let i = xi.get(r.x1)!; i < xi.get(r.x2)!; i++) {
      for (let j = yi.get(r.y1)!; j < yi.get(r.y2)!; j++) filled[i][j] = true
    }
  }
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && filled[i][j]

  // Directed boundary edges (counter-clockwise around filled cells), keyed by
  // start vertex "i,j" in grid-vertex space.
  const edges = new Map<string, [number, number][]>()
  const add = (a: [number, number], b: [number, number]) => {
    const k = `${a[0]},${a[1]}`
    const list = edges.get(k)
    if (list) list.push(b); else edges.set(k, [b])
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!filled[i][j]) continue
      if (!at(i, j - 1)) add([i, j], [i + 1, j])              // bottom
      if (!at(i + 1, j)) add([i + 1, j], [i + 1, j + 1])      // right
      if (!at(i, j + 1)) add([i + 1, j + 1], [i, j + 1])      // top
      if (!at(i - 1, j)) add([i, j + 1], [i, j])              // left
    }
  }

  const loops: [number, number][][] = []
  for (const [startKey] of edges) {
    while (edges.get(startKey)?.length) {
      const [sx, sy] = startKey.split(',').map(Number) as [number, number]
      const pts: [number, number][] = [[sx, sy]]
      let cur: [number, number] = [sx, sy]
      for (;;) {
        const list = edges.get(`${cur[0]},${cur[1]}`)
        if (!list || list.length === 0) break
        const next = list.shift()!
        if (next[0] === sx && next[1] === sy) break
        pts.push(next)
        cur = next
      }
      // drop collinear vertices
      const simp = pts.filter((p, k) => {
        const a = pts[(k + pts.length - 1) % pts.length], b = pts[(k + 1) % pts.length]
        return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
      })
      if (simp.length >= 4) loops.push(simp.map(([i, j]) => [xs[i], ys[j]] as [number, number]))
    }
  }
  return loops
}

/** One merged outline per distinct fill/border style. `maxAltFt` clamps band
 *  tops to the chart's top edge; bands entirely above it are dropped. */
export function airspaceOutlines(bands: OutlineBand[], maxAltFt = Infinity): OutlineShape[] {
  const groups = new Map<string, { fill: string; border: string; rects: Rect[] }>()
  for (const b of bands) {
    if (b.lower_ft >= maxAltFt) continue
    const y2 = Math.min(b.upper_ft, maxAltFt)
    if (!(b.exitNm > b.entryNm) || !(y2 > b.lower_ft)) continue
    const key = `${b.fill}|${b.border}`
    let g = groups.get(key)
    if (!g) { g = { fill: b.fill, border: b.border, rects: [] }; groups.set(key, g) }
    g.rects.push({ x1: b.entryNm, x2: b.exitNm, y1: b.lower_ft, y2 })
  }
  return [...groups.values()].map((g) => ({ fill: g.fill, border: g.border, loops: unionRectLoops(g.rects) }))
}
