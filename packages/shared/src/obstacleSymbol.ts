/**
 * Full-height obstacle symbols for the Virtual Radar: a building, mast,
 * chimney, wind turbine or water tower drawn from the ground up to its real
 * tip altitude, so the chart shows how tall it is.
 *
 * Pure geometry in chart pixels; web renders it as SVG elements, native as
 * react-native-svg elements. Obstacles shorter than MIN_FULL_HEIGHT_PX stay a
 * small pictogram (callers draw the old icon for them).
 */

export type SymbolPrim =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: string; stroke?: string; dash?: boolean }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; w: number; dash?: boolean }
  | { t: 'poly'; pts: [number, number][]; fill: string; stroke?: string; dash?: boolean }
  | { t: 'circle'; cx: number; cy: number; r: number; fill: string; dash?: boolean }

/** Below this on-screen height the full shape is just a smudge: use the icon. */
export const MIN_FULL_HEIGHT_PX = 10

// Mid-tone sky and green / blue ground: light fills with a dark outline read on both.
const RED = '#ef4a36'
const RED_SOFT = 'rgba(239,74,54,0.8)'
const STEEL = '#dbe4ee'
const STEEL_DARK = '#16202e'
const WINDOW = 'rgba(30,41,59,0.6)'
const WHITE = '#f8fafc'
const HALO = 'rgba(8,16,28,0.8)'
/** Right-hand half of a round shaft: a front view with a hint of depth. */
const SHADE = 'rgba(15,23,42,0.3)'

/** Fill opacity of an estimated (assumed-height) symbol: a little lighter than a measured one, never hollow
 *  and never dashed (a dashed outline breaks a thin tower into dots). The "(est.)" in its name says the rest. */
export const ESTIMATED_FILL_OPACITY = 0.7

/** How an obstacle kind is widened (not heightened: height is data) when drawn. Thin masts are stretched
 *  to stay visible; a turbine (already wide: its rotor) and a building are not, or they dwarf a church. */
export function obstacleXScale(kind: string): number {
  switch (kind) {
    case 'wind_turbine': return 1
    case 'building': return 1.2
    case 'water_tower': return 1.3
    case 'chimney': return 1.5
    default: return 1.6
  }
}

/** Paint of a rect / poly primitive, the same for web and native. */
export function primStyle(p: Extract<SymbolPrim, { t: 'rect' | 'poly' }>): { fill: string; fillOpacity: number; stroke?: string } {
  return { fill: p.fill, fillOpacity: p.dash ? ESTIMATED_FILL_OPACITY : 1, stroke: p.stroke ?? (p.dash ? p.fill : undefined) }
}

/** Shape of one obstacle, or null when it is too short for a full-height drawing.
 *  `estimated`: the height is an assumption, every primitive is flagged `dash` so
 *  the renderer draws it a little lighter. */
export function obstacleSymbol(kind: string, cx: number, tipY: number, groundY: number, estimated = false): SymbolPrim[] | null {
  const prims = obstacleSymbolSolid(kind, cx, tipY, groundY)
  if (prims && estimated) for (const p of prims) p.dash = true
  return prims
}

function obstacleSymbolSolid(kind: string, cx: number, tipY: number, groundY: number): SymbolPrim[] | null {
  const h = groundY - tipY
  if (!(h >= MIN_FULL_HEIGHT_PX)) return null
  const prims: SymbolPrim[] = []

  switch (kind) {
    case 'building': {
      const w = Math.max(6, Math.min(14, h * 0.45))
      prims.push({ t: 'rect', x: cx - w / 2, y: tipY, w, h, fill: STEEL, stroke: STEEL_DARK })
      prims.push({ t: 'rect', x: cx + w / 4, y: tipY, w: w / 4, h, fill: SHADE })
      // Rows of windows, just enough to read as a building.
      const rows = Math.min(8, Math.floor(h / 6))
      for (let i = 1; i <= rows; i++) {
        const y = tipY + (i * h) / (rows + 1)
        prims.push({ t: 'line', x1: cx - w / 2 + 1.5, y1: y, x2: cx + w / 2 - 1.5, y2: y, stroke: WINDOW, w: 1 })
      }
      break
    }
    case 'chimney': {
      // Front elevation, tapered, right half shaded for depth (cylinder
      // look), two pale bands and a dark rim.
      const bw = Math.max(5, Math.min(9, h * 0.25)), tw = bw * 0.62
      const halfAt = (y: number) => (tw + ((bw - tw) * (y - tipY)) / h) / 2
      prims.push({
        t: 'poly', fill: RED, stroke: STEEL_DARK,
        pts: [[cx - tw / 2, tipY], [cx + tw / 2, tipY], [cx + bw / 2, groundY], [cx - bw / 2, groundY]],
      })
      prims.push({ t: 'poly', fill: SHADE, pts: [[cx, tipY], [cx + tw / 2, tipY], [cx + bw / 2, groundY], [cx, groundY]] })
      for (const f of [0.14, 0.4]) {
        const y0 = tipY + h * f, y1 = y0 + Math.max(1.5, h * 0.1)
        prims.push({ t: 'poly', fill: WHITE, pts: [[cx - halfAt(y0), y0], [cx + halfAt(y0), y0], [cx + halfAt(y1), y1], [cx - halfAt(y1), y1]] })
      }
      prims.push({ t: 'rect', x: cx - tw / 2 - 1, y: tipY, w: tw + 2, h: Math.min(2, h * 0.1), fill: STEEL_DARK })
      break
    }
    case 'wind_turbine': {
      // The tip altitude is the top of the highest blade: hub one rotor radius below it. A white tower and
      // three white blades (as real turbines are), each on a dark halo: at 1-3 px wide, a dark outline
      // drawn around a white fill would swallow it and the turbine would look black.
      // Proportioned to the real height (rotor about a third of it), capped so the span stays about a
      // landmark icon wide (14 px) however tall the turbine is.
      const r = Math.max(3.2, Math.min(8, h * 0.34))
      const hubY = tipY + r
      // A slim tower: about 1.4 px wide under the hub, 2 px at the foot (halo adds 0.7 px each side), so it
      // reads as a pole, not a stump.
      const top = 0.7, foot = 1
      const tower = (grow: number, fill: string): SymbolPrim =>
        ({ t: 'poly', fill, pts: [[cx - top - grow, hubY], [cx + top + grow, hubY], [cx + foot + grow, groundY], [cx - foot - grow, groundY]] })
      prims.push(tower(0.7, HALO), tower(0, WHITE))
      prims.push({ t: 'poly', fill: SHADE, pts: [[cx, hubY], [cx + top, hubY], [cx + foot, groundY], [cx, groundY]] })
      const blades = [-90, 30, 150].map((deg) => {
        const a = (deg * Math.PI) / 180
        return { x2: cx + Math.cos(a) * r, y2: hubY + Math.sin(a) * r }
      })
      const bw = r < 6 ? 1.5 : 2
      for (const b of blades) prims.push({ t: 'line', x1: cx, y1: hubY, x2: b.x2, y2: b.y2, stroke: HALO, w: bw + 2 })
      for (const b of blades) prims.push({ t: 'line', x1: cx, y1: hubY, x2: b.x2, y2: b.y2, stroke: WHITE, w: bw })
      prims.push({ t: 'circle', cx, cy: hubY, r: bw + 1.2, fill: HALO })
      prims.push({ t: 'circle', cx, cy: hubY, r: bw + 0.2, fill: WHITE })
      break
    }
    case 'water_tower': {
      const r = Math.max(4, Math.min(8, h * 0.28))
      prims.push({ t: 'line', x1: cx, y1: groundY, x2: cx, y2: tipY + r * 1.6, stroke: STEEL, w: 2.5 })
      prims.push({ t: 'poly', fill: STEEL, stroke: STEEL_DARK, pts: [[cx - r, tipY + r * 0.6], [cx - r * 0.7, tipY], [cx + r * 0.7, tipY], [cx + r, tipY + r * 0.6], [cx + r * 0.6, tipY + r * 1.6], [cx - r * 0.6, tipY + r * 1.6]] })
      break
    }
    default: {
      // Tower / mast / anything else tall and thin: a lattice mast (two legs,
      // zig-zag bracing), two guy wires and a beacon at the top.
      const half = Math.max(1.5, Math.min(3, h * 0.04))
      const legL = (y: number) => cx - half * (0.5 + ((y - tipY) / h) * 0.5)
      const legR = (y: number) => cx + half * (0.5 + ((y - tipY) / h) * 0.5)
      // Dark under-strokes, so thin red lines hold up against the sky.
      prims.push({ t: 'line', x1: legL(tipY), y1: tipY, x2: legL(groundY), y2: groundY, stroke: HALO, w: 3.5 })
      prims.push({ t: 'line', x1: legR(tipY), y1: tipY, x2: legR(groundY), y2: groundY, stroke: HALO, w: 3.5 })
      prims.push({ t: 'line', x1: legL(tipY), y1: tipY, x2: legL(groundY), y2: groundY, stroke: RED, w: 1.8 })
      prims.push({ t: 'line', x1: legR(tipY), y1: tipY, x2: legR(groundY), y2: groundY, stroke: RED, w: 1.8 })
      const cells = Math.max(2, Math.min(8, Math.floor(h / 7)))
      for (let i = 0; i < cells; i++) {
        const y0 = tipY + (i * h) / cells, y1 = tipY + ((i + 1) * h) / cells
        const left = i % 2 === 0
        prims.push({ t: 'line', x1: left ? legL(y0) : legR(y0), y1: y0, x2: left ? legR(y1) : legL(y1), y2: y1, stroke: RED_SOFT, w: 1 })
      }
      const guy = Math.min(8, h * 0.3)
      prims.push({ t: 'line', x1: cx, y1: tipY + h * 0.45, x2: cx - guy, y2: groundY, stroke: RED_SOFT, w: 1 })
      prims.push({ t: 'line', x1: cx, y1: tipY + h * 0.45, x2: cx + guy, y2: groundY, stroke: RED_SOFT, w: 1 })
      prims.push({ t: 'circle', cx, cy: tipY + 2, r: 2, fill: RED })
    }
  }
  return prims
}

/** SVG path data for a 'poly' primitive. */
export function polyPath(pts: [number, number][]): string {
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z'
}
