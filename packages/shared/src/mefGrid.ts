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
