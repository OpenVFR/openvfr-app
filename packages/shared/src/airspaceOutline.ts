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
  /** Closed loops in (distNm, altFt) of the merged area; several loops = outer
   *  boundary + holes or separate islands. Fill with the even-odd rule. */
  loops:  [number, number][][]
  /** Border pieces [x1, y1, x2, y2]: every sector's own edges, except pieces
   *  lying strictly inside another sector of the same style. Sectors that only
   *  touch keep the line between them. */
  segments: [number, number, number, number][]
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

/** Edges of every rectangle. Floor/ceiling pieces strictly inside another
 *  rectangle are dropped (a higher floor drawn through a lower sector); side
 *  edges are always kept so each sector's extent stays readable. Duplicates
 *  are drawn once. */
export function visibleEdges(rects: Rect[]): [number, number, number, number][] {
  const inside = (x: number, y: number) =>
    rects.some((r) => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2)
  const seen = new Set<string>()
  const h: [number, number, number][] = []   // [y, xa, xb]
  const v: [number, number, number][] = []   // [x, ya, yb]
  for (const r of rects) {
    const xs = [...new Set([r.x1, r.x2, ...rects.flatMap((o) => [o.x1, o.x2]).filter((x) => x > r.x1 && x < r.x2)])].sort((a, b) => a - b)
    const ys = [...new Set([r.y1, r.y2, ...rects.flatMap((o) => [o.y1, o.y2]).filter((y) => y > r.y1 && y < r.y2)])].sort((a, b) => a - b)
    for (const y of [r.y1, r.y2]) {
      for (let i = 0; i < xs.length - 1; i++) {
        const key = `h|${y}|${xs[i]}|${xs[i + 1]}`
        if (seen.has(key) || inside((xs[i] + xs[i + 1]) / 2, y)) continue
        seen.add(key); h.push([y, xs[i], xs[i + 1]])
      }
    }
    for (const x of [r.x1, r.x2]) {
      for (let j = 0; j < ys.length - 1; j++) {
        const key = `v|${x}|${ys[j]}|${ys[j + 1]}`
        if (seen.has(key)) continue   // side edges are always kept, even inside another sector
        seen.add(key); v.push([x, ys[j], ys[j + 1]])
      }
    }
  }
  // Join collinear pieces that touch end to end.
  const join = (list: [number, number, number][]) => {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const out: [number, number, number][] = []
    for (const seg of list) {
      const last = out[out.length - 1]
      if (last && last[0] === seg[0] && last[2] >= seg[1]) last[2] = Math.max(last[2], seg[2])
      else out.push([...seg])
    }
    return out
  }
  return [
    ...join(h).map(([y, xa, xb]) => [xa, y, xb, y] as [number, number, number, number]),
    ...join(v).map(([x, ya, yb]) => [x, ya, x, yb] as [number, number, number, number]),
  ]
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
  return [...groups.values()].map((g) => ({
    fill: g.fill, border: g.border,
    loops: unionRectLoops(g.rects),
    segments: visibleEdges(g.rects),
  }))
}

export interface OutlineChip {
  x: number      // distance along route (NM) of the band's start
  y: number      // altitude (ft) of the band's visible top
  tag: string
  freq?: string
  border: string
}

/** Pixel size of a rendered chip (9.5px bold tag cell + frequency cell).
 *  Shared so both charts draw chips the same size and other labels (cloud
 *  layers) can avoid them. */
export function airspaceChipSize(chip: Pick<OutlineChip, 'tag' | 'freq'>): { tagW: number; freqW: number; w: number; h: number } {
  const tagW = chip.tag.length * 6.4 + 6
  const freqW = chip.freq ? chip.freq.length * 6.1 + 6 : 0
  return { tagW, freqW, w: tagW + freqW, h: 13 }
}

/** One label chip per band, at its top-left corner. Bands of the same class and
 *  frequency starting at the same place (stacked sub-sectors) share one chip. */
export function airspaceChips(
  bands: (OutlineBand & { tag: string; freq?: string })[],
  maxAltFt = Infinity,
): OutlineChip[] {
  const seen = new Set<string>()
  const out: OutlineChip[] = []
  for (const b of bands) {
    if (b.lower_ft >= maxAltFt || !(b.exitNm > b.entryNm)) continue
    const y = Math.min(b.upper_ft, maxAltFt)
    const key = `${b.tag}|${b.freq ?? ''}|${b.entryNm}|${y}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ x: b.entryNm, y, tag: b.tag, freq: b.freq, border: b.border })
  }
  return out
}
