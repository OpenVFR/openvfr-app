/**
 * mefGrid — reader for the `<cc>-mef.mef` grid-maximum-elevation file the
 * infra pipeline builds (openvfr-infra scripts/mef_format.py has the layout).
 *
 * Each cell holds the HIGHEST terrain inside it (max of the 30 m DEM, rounded
 * up to 100 ft), a few MB per country. It gives an offline, conservative
 * corridor-maximum terrain figure for the MSA line without downloading the
 * 200+ MB hillshade DEM. It never under-reports terrain; a narrow ridge in
 * flat country can raise a nearby leg's MSA (the safe direction). Obstacles
 * are not in it: they are checked individually at their real positions.
 *
 * Layout (little endian): "OMEF", version u8 (1), flags u8, unit_ft u16,
 * cols u32, rows u32, west f64, north f64, cell_lon f64, cell_lat f64, then a
 * zlib stream of cols*rows bytes, north -> south. Codes: 0 = sea level,
 * 1..254 = code * unit_ft, 255 = no data.
 */

import { unzlibSync } from 'fflate'

export const MEF_NODATA = 255
const HEADER_BYTES = 48
const NM_PER_DEG_LAT = 60

export type MefGrid = {
  codes: Uint8Array
  cols: number
  rows: number
  west: number
  north: number
  cellLon: number
  cellLat: number
  unitFt: number
}

/** Parse a `.mef` file. Returns null for anything that is not a valid v1 file. */
export function parseMef(bytes: Uint8Array): MefGrid | null {
  if (bytes.length < HEADER_BYTES) return null
  if (bytes[0] !== 0x4f || bytes[1] !== 0x4d || bytes[2] !== 0x45 || bytes[3] !== 0x46) return null // "OMEF"
  if (bytes[4] !== 1) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const unitFt = dv.getUint16(6, true)
  const cols = dv.getUint32(8, true)
  const rows = dv.getUint32(12, true)
  const west = dv.getFloat64(16, true)
  const north = dv.getFloat64(24, true)
  const cellLon = dv.getFloat64(32, true)
  const cellLat = dv.getFloat64(40, true)
  if (!cols || !rows || !(cellLon > 0) || !(cellLat > 0) || !unitFt) return null
  let codes: Uint8Array
  try { codes = unzlibSync(bytes.subarray(HEADER_BYTES)) } catch { return null }
  if (codes.length !== cols * rows) return null
  return { codes, cols, rows, west, north, cellLon, cellLat, unitFt }
}

/** Highest-terrain figure (ft) of the cell containing the point, or null for no data / outside. */
export function mefFtAt(grid: MefGrid, lat: number, lng: number): number | null {
  const col = Math.floor((lng - grid.west) / grid.cellLon)
  const row = Math.floor((grid.north - lat) / grid.cellLat)
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return null
  const c = grid.codes[row * grid.cols + col]
  return c === MEF_NODATA ? null : c * grid.unitFt
}

/**
 * Highest terrain (ft) within `radiusNm` of a point, over every grid given
 * (several countries can overlap at borders). A cell counts when any part of
 * it can be within the radius (centre distance <= radius + half the cell
 * diagonal), so the result errs high, never low. null = no data anywhere.
 */
export function corridorMaxFt(grids: readonly MefGrid[], lat: number, lng: number, radiusNm: number): number | null {
  let best: number | null = null
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180))
  for (const g of grids) {
    const cellNsNm = g.cellLat * NM_PER_DEG_LAT
    const cellEwNm = g.cellLon * NM_PER_DEG_LAT * cosLat
    const reach = radiusNm + 0.5 * Math.hypot(cellNsNm, cellEwNm)
    const dLat = reach / NM_PER_DEG_LAT
    const dLng = reach / (NM_PER_DEG_LAT * cosLat)
    const r0 = Math.max(0, Math.floor((g.north - (lat + dLat)) / g.cellLat))
    const r1 = Math.min(g.rows - 1, Math.floor((g.north - (lat - dLat)) / g.cellLat))
    const c0 = Math.max(0, Math.floor((lng - dLng - g.west) / g.cellLon))
    const c1 = Math.min(g.cols - 1, Math.floor((lng + dLng - g.west) / g.cellLon))
    for (let r = r0; r <= r1; r++) {
      const cy = g.north - (r + 0.5) * g.cellLat
      const dyNm = (cy - lat) * NM_PER_DEG_LAT
      for (let c = c0; c <= c1; c++) {
        const code = g.codes[r * g.cols + c]
        if (code === MEF_NODATA) continue
        const ft = code * g.unitFt
        if (best !== null && ft <= best) continue
        const dxNm = (g.west + (c + 0.5) * g.cellLon - lng) * NM_PER_DEG_LAT * cosLat
        if (Math.hypot(dxNm, dyNm) <= reach) best = ft
      }
    }
  }
  return best
}

// ── Corridor geometry (swept strip along a leg, caps at its ends) ───────────
//
// The corridor of a route is the area within `abeamNm` of its track: a strip
// along each leg plus, at every waypoint, the part of the circle of that
// radius that neither leg's strip covers (the outside of a turn; the half
// circle before the start and after the end). Each sample of the vertical
// profile reports the highest cell of ITS stretch of strip, so a hill counts
// where it is abeam, not 5 NM before and after it, and nothing between two
// samples is skipped: cells, not points, are tested, and a cell counts when
// any part of it can lie inside (centre test widened by half the cell's
// diagonal), so a figure errs high, never low.
//
// Distances use a local flat projection around the leg (equirectangular,
// NM). Over a few tens of NM its error is far below one cell.

export type LatLng = { lat: number; lng: number }

type Frame = { lat0: number; lng0: number; cosLat: number }

function frameAt(lat: number, lng: number): Frame {
  return { lat0: lat, lng0: lng, cosLat: Math.max(0.05, Math.cos((lat * Math.PI) / 180)) }
}

/** Point in NM east (x) / north (y) of the frame origin. */
function toXY(f: Frame, lat: number, lng: number): { x: number; y: number } {
  return { x: (lng - f.lng0) * NM_PER_DEG_LAT * f.cosLat, y: (lat - f.lat0) * NM_PER_DEG_LAT }
}

/** Visit every data cell whose centre lies within `reachNm` of the box [x0,x1]x[y0,y1] (frame NM), with its centre. */
function forCellsNear(
  grids: readonly MefGrid[], f: Frame, x0: number, x1: number, y0: number, y1: number,
  visit: (ft: number, cx: number, cy: number, halfDiagNm: number) => void,
): void {
  for (const g of grids) {
    const half = 0.5 * Math.hypot(g.cellLat * NM_PER_DEG_LAT, g.cellLon * NM_PER_DEG_LAT * f.cosLat)
    const latMin = f.lat0 + (y0 - half) / NM_PER_DEG_LAT, latMax = f.lat0 + (y1 + half) / NM_PER_DEG_LAT
    const lngMin = f.lng0 + (x0 - half) / (NM_PER_DEG_LAT * f.cosLat), lngMax = f.lng0 + (x1 + half) / (NM_PER_DEG_LAT * f.cosLat)
    const r0 = Math.max(0, Math.floor((g.north - latMax) / g.cellLat))
    const r1 = Math.min(g.rows - 1, Math.floor((g.north - latMin) / g.cellLat))
    const c0 = Math.max(0, Math.floor((lngMin - g.west) / g.cellLon))
    const c1 = Math.min(g.cols - 1, Math.floor((lngMax - g.west) / g.cellLon))
    for (let r = r0; r <= r1; r++) {
      const cy = (g.north - (r + 0.5) * g.cellLat - f.lat0) * NM_PER_DEG_LAT
      for (let c = c0; c <= c1; c++) {
        const code = g.codes[r * g.cols + c]!
        if (code === MEF_NODATA) continue
        const cx = (g.west + (c + 0.5) * g.cellLon - f.lng0) * NM_PER_DEG_LAT * f.cosLat
        visit(code * g.unitFt, cx, cy, half)
      }
    }
  }
}

/**
 * Highest terrain (ft) in the strip along the leg a->b from `fromNm` to `toNm`
 * (measured from a along the leg, in the leg's own length units: pass
 * fractions of `legNm`, the length the caller measures the leg with) and
 * within `abeamNm` either side of it. null = no data.
 */
export function segmentStripMaxFt(
  grids: readonly MefGrid[], a: LatLng, b: LatLng, legNm: number, fromNm: number, toNm: number, abeamNm: number,
): number | null {
  const f = frameAt((a.lat + b.lat) / 2, (a.lng + b.lng) / 2)
  const pa = toXY(f, a.lat, a.lng), pb = toXY(f, b.lat, b.lng)
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y)
  if (!(len > 1e-9) || !(legNm > 0)) return null
  const ux = (pb.x - pa.x) / len, uy = (pb.y - pa.y) / len
  // Caller's distances are along its own (geodesic) length: rescale.
  const s = len / legNm
  const lo = Math.min(fromNm, toNm) * s, hi = Math.max(fromNm, toNm) * s
  const corners = [[lo, -abeamNm], [lo, abeamNm], [hi, -abeamNm], [hi, abeamNm]].map(([al, cr]) => ({
    x: pa.x + ux * al! - uy * cr!, y: pa.y + uy * al! + ux * cr!,
  }))
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y)
  let best: number | null = null
  forCellsNear(grids, f, Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), (ft, cx, cy, half) => {
    if (best !== null && ft <= best) return
    const dx = cx - pa.x, dy = cy - pa.y
    const along = dx * ux + dy * uy, cross = Math.abs(-dx * uy + dy * ux)
    if (along >= lo - half && along <= hi + half && cross <= abeamNm + half) best = ft
  })
  return best
}

/**
 * Highest terrain (ft) within `radiusNm` of waypoint `wp`. With `wedgeOnly`,
 * only the part no leg strip covers: beyond the end of the incoming leg
 * (prev->wp) AND before the start of the outgoing one (wp->next); a missing
 * leg counts as covering nothing. null = no data.
 */
export function waypointCapMaxFt(
  grids: readonly MefGrid[], wp: LatLng, prev: LatLng | null, next: LatLng | null, radiusNm: number, wedgeOnly: boolean,
): number | null {
  const f = frameAt(wp.lat, wp.lng)
  const dirTo = (p: LatLng | null) => {
    if (!p) return null
    const q = toXY(f, p.lat, p.lng)
    const l = Math.hypot(q.x, q.y)
    return l > 1e-9 ? { x: q.x / l, y: q.y / l } : null
  }
  // Unit vectors from the waypoint back along the incoming leg / out along the outgoing one.
  const back = dirTo(prev), out = dirTo(next)
  let best: number | null = null
  forCellsNear(grids, f, -radiusNm, radiusNm, -radiusNm, radiusNm, (ft, cx, cy, half) => {
    if (best !== null && ft <= best) return
    if (Math.hypot(cx, cy) > radiusNm + half) return
    if (wedgeOnly) {
      // Inside a strip = in front of the waypoint along that leg (dot > 0).
      // Widened by the cell half-diagonal so border cells count for the cap too.
      if (back && cx * back.x + cy * back.y > half) return
      if (out && cx * out.x + cy * out.y > half) return
    }
    best = ft
  })
  return best
}

// ── Loading ─────────────────────────────────────────────────────────────────

const _cache = new Map<string, Promise<MefGrid | null>>()

/**
 * Load one or more grids through a platform-supplied byte fetcher (web: fetch
 * the versioned tile URL; native: cached file or remote). Cached per key; a
 * failed or invalid file resolves to null and is retried on the next call, so
 * a missing file (pipeline not run yet) just means "no corridor figure".
 */
export function loadMefGrids(
  sources: readonly { key: string; load: () => Promise<Uint8Array> }[],
): Promise<MefGrid[]> {
  return Promise.all(sources.map((s) => {
    let p = _cache.get(s.key)
    if (!p) {
      p = s.load().then(parseMef).catch(() => null)
      p.then((g) => { if (!g && _cache.get(s.key) === p) _cache.delete(s.key) })
      _cache.set(s.key, p)
    }
    return p
  })).then((gs) => gs.filter((g): g is MefGrid => g !== null))
}
