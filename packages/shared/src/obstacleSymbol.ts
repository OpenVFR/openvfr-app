/**
 * Full-height obstacle symbols for the Virtual Radar: a building, mast,
 * chimney, wind turbine or water tower drawn from the ground up to its real
 * tip altitude, so the chart shows how tall it is (the same idea as the
 * reference planner, which stretches the symbol to the obstacle's height).
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

const RED = 'rgba(220,80,60,0.95)'
const RED_SOFT = 'rgba(220,80,60,0.55)'
const STEEL = 'rgba(148,163,184,0.95)'
const STEEL_DARK = 'rgba(71,85,105,0.95)'
const WINDOW = 'rgba(226,232,240,0.55)'
const WHITE = 'rgba(241,245,249,0.95)'

/** Dash pattern of an estimated (assumed-height) symbol's outline, in px. */
export const ESTIMATED_DASH = '3 2'

/** Shape of one obstacle, or null when it is too short for a full-height drawing.
 *  `estimated`: the height is an assumption, every primitive is flagged `dash` so
 *  the renderer draws it dashed and lighter. */
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
      // Rows of windows, just enough to read as a building.
      const rows = Math.min(8, Math.floor(h / 6))
      for (let i = 1; i <= rows; i++) {
        const y = tipY + (i * h) / (rows + 1)
        prims.push({ t: 'line', x1: cx - w / 2 + 1.5, y1: y, x2: cx + w / 2 - 1.5, y2: y, stroke: WINDOW, w: 1 })
      }
      break
    }
    case 'chimney': {
      const bw = Math.max(5, Math.min(9, h * 0.25)), tw = bw * 0.62
      prims.push({
        t: 'poly', fill: RED, stroke: STEEL_DARK,
        pts: [[cx - tw / 2, tipY], [cx + tw / 2, tipY], [cx + bw / 2, groundY], [cx - bw / 2, groundY]],
      })
      prims.push({ t: 'rect', x: cx - tw / 2, y: tipY, w: tw, h: Math.min(4, h * 0.2), fill: WHITE })
      break
    }
    case 'wind_turbine': {
      // The tip altitude is the top of the highest blade: hub one rotor
      // radius below it.
      const r = Math.max(5, Math.min(18, h * 0.38))
      const hubY = tipY + r
      prims.push({ t: 'line', x1: cx, y1: groundY, x2: cx, y2: hubY, stroke: WHITE, w: 2 })
      for (const deg of [-90, 30, 150]) {
        const a = (deg * Math.PI) / 180
        prims.push({ t: 'line', x1: cx, y1: hubY, x2: cx + r * Math.cos(a), y2: hubY + r * Math.sin(a), stroke: WHITE, w: 1.5 })
      }
      prims.push({ t: 'circle', cx, cy: hubY, r: 1.8, fill: RED })
      break
    }
    case 'water_tower': {
      const r = Math.max(4, Math.min(8, h * 0.28))
      prims.push({ t: 'line', x1: cx, y1: groundY, x2: cx, y2: tipY + r * 1.6, stroke: STEEL, w: 2.5 })
      prims.push({ t: 'poly', fill: STEEL, stroke: STEEL_DARK, pts: [[cx - r, tipY + r * 0.6], [cx - r * 0.7, tipY], [cx + r * 0.7, tipY], [cx + r, tipY + r * 0.6], [cx + r * 0.6, tipY + r * 1.6], [cx - r * 0.6, tipY + r * 1.6]] })
      break
    }
    default: {
      // Tower / mast / anything else tall and thin: a lattice-like pole with a
      // beacon at the top and two guy lines.
      prims.push({ t: 'line', x1: cx, y1: groundY, x2: cx, y2: tipY, stroke: RED, w: 2 })
      const guy = Math.min(8, h * 0.3)
      prims.push({ t: 'line', x1: cx, y1: tipY + h * 0.45, x2: cx - guy, y2: groundY, stroke: RED_SOFT, w: 1 })
      prims.push({ t: 'line', x1: cx, y1: tipY + h * 0.45, x2: cx + guy, y2: groundY, stroke: RED_SOFT, w: 1 })
      prims.push({ t: 'circle', cx, cy: tipY + 2.4, r: 2.4, fill: RED })
    }
  }
  return prims
}

/** SVG path data for a 'poly' primitive. */
export function polyPath(pts: [number, number][]): string {
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z'
}
