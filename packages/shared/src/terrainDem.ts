/**
 * terrainDem — ground elevation from the self-hosted hillshade archive
 * (`se-hillshade.pmtiles`, Copernicus GLO-30, Terrarium-encoded PNG raster-dem
 * tiles), as an offline fallback for the OpenTopoData elevation API used by
 * the vertical profile (terrain line, MSA, AGL airspace bands) and the live
 * AGL readout / AGL airspace limits.
 *
 * Memory contract (this app has crashed from oversized tile reads before;
 * see the PMTiles/OOM gotchas in AGENTS.md):
 *  - Only ranged reads ever happen: header + directories (a few KB) and one
 *    256x256 PNG tile (~130 KB) at a time. The archive itself is never read
 *    whole. Callers supply a `RangeSource`; on native that is a local
 *    `file://` handle, never the network.
 *  - Decoded tiles are stored as Int16 metres (128 KB each) in a small LRU
 *    (TILE_CACHE_SIZE), so the steady-state footprint is well under 1 MB.
 *    PNG bytes and the inflated RGB plane are transient and dropped at once.
 *  - The PNG decoder below is deliberately minimal: 8-bit RGB/RGBA,
 *    non-interlaced, which is what the pipeline produces (gdal_translate
 *    -co TILE_FORMAT=PNG, nearest resampling). Anything else returns null
 *    rather than attempting a general decode.
 *
 * Resolution: the archive's max zoom (10 for Sweden) is ~75-150 m per pixel,
 * coarser than the 25 m API, but with nearest-neighbour overviews (no
 * averaging) each pixel is a real DEM value. Fine for MSA (+1000 ft) and AGL
 * limit lifting, which is what this is for.
 *
 * Terrarium: elevation_m = R * 256 + G + B / 256 - 32768.
 */

import { PMTiles, type Source, type RangeResponse } from 'pmtiles'
import { unzlibSync } from 'fflate'

export type RangeSource = Source
export type { RangeResponse }

export const TILE_CACHE_SIZE = 6
const TILE_PX = 256
const FT_PER_M = 3.28084

/** Elevation lookup shared by the API path and the DEM path. */
export type ElevationLookup = {
  /** Ground elevation in feet AMSL, or null when unknown / outside coverage. */
  elevationFt(lat: number, lng: number): Promise<number | null>
}

// ── Minimal PNG → Int16 metres ──────────────────────────────────────────────

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode a Terrarium PNG tile to Int16 metres (row-major, TILE_PX²).
 * Returns null for anything but 8-bit RGB/RGBA non-interlaced 256x256.
 */
export function decodeTerrariumPng(png: Uint8Array): Int16Array | null {
  if (png.length < 33) return null
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) return null
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = dv.getUint32(16), height = dv.getUint32(20)
  const bitDepth = png[24], colorType = png[25], interlace = png[28]
  if (width !== TILE_PX || height !== TILE_PX || bitDepth !== 8 || interlace !== 0) return null
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0
  if (channels === 0) return null

  // Concatenate IDAT chunks.
  const idat: Uint8Array[] = []
  let total = 0
  let pos = 8
  while (pos + 8 <= png.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7])
    const start = pos + 8
    if (type === 'IDAT') { idat.push(png.subarray(start, start + len)); total += len }
    if (type === 'IEND') break
    pos = start + len + 4
  }
  if (total === 0) return null
  let zdata: Uint8Array
  if (idat.length === 1) zdata = idat[0]
  else {
    zdata = new Uint8Array(total)
    let o = 0
    for (const c of idat) { zdata.set(c, o); o += c.length }
  }

  const stride = width * channels
  const raw = unzlibSync(zdata)
  if (raw.length < (stride + 1) * height) return null

  // Un-filter in place into `prev`/`cur` rows, emitting elevation as we go so
  // the full RGB plane never needs a second copy.
  const out = new Int16Array(width * height)
  let prev = new Uint8Array(stride)
  let cur = new Uint8Array(stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++]
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let r: number
      switch (filter) {
        case 0: r = v; break
        case 1: r = v + a; break
        case 2: r = v + b; break
        case 3: r = v + ((a + b) >> 1); break
        case 4: r = v + paeth(a, b, c); break
        default: return null
      }
      cur[x] = r & 0xff
    }
    const rowOff = y * width
    for (let x = 0, px = 0; x < width; x++, px += channels) {
      const m = cur[px] * 256 + cur[px + 1] + cur[px + 2] / 256 - 32768
      out[rowOff + x] = Math.max(-32768, Math.min(32767, Math.round(m)))
    }
    const t = prev; prev = cur; cur = t
  }
  return out
}

// ── Tile maths ──────────────────────────────────────────────────────────────

/** Web-Mercator tile + pixel for a coordinate at zoom z. */
export function latLngToTilePixel(lat: number, lng: number, z: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z
  const latR = lat * Math.PI / 180
  const fx = (lng + 180) / 360 * n
  const fy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n
  const x = Math.floor(fx), y = Math.floor(fy)
  return {
    x, y,
    px: Math.min(TILE_PX - 1, Math.max(0, Math.floor((fx - x) * TILE_PX))),
    py: Math.min(TILE_PX - 1, Math.max(0, Math.floor((fy - y) * TILE_PX))),
  }
}

// ── DEM reader ──────────────────────────────────────────────────────────────

export class PmtilesDem implements ElevationLookup {
  private readonly pm: PMTiles
  private header: Promise<{ minLon: number; minLat: number; maxLon: number; maxLat: number; maxZoom: number; tileType: number }> | null = null
  private readonly cache = new Map<string, Int16Array | null>()
  private readonly pending = new Map<string, Promise<Int16Array | null>>()

  constructor(source: RangeSource) {
    this.pm = new PMTiles(source)
  }

  private getHeader() {
    if (!this.header) this.header = this.pm.getHeader()
    return this.header
  }

  private async tile(z: number, x: number, y: number): Promise<Int16Array | null> {
    const key = `${z}/${x}/${y}`
    const hit = this.cache.get(key)
    if (hit !== undefined) {
      // Refresh LRU position.
      this.cache.delete(key); this.cache.set(key, hit)
      return hit
    }
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    const p = (async () => {
      try {
        const res = await this.pm.getZxy(z, x, y)
        const dem = res ? decodeTerrariumPng(new Uint8Array(res.data)) : null
        this.cache.set(key, dem)
        while (this.cache.size > TILE_CACHE_SIZE) {
          const oldest = this.cache.keys().next().value
          if (oldest === undefined) break
          this.cache.delete(oldest)
        }
        return dem
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, p)
    return p
  }

  /** Ground elevation in metres, or null outside coverage / on decode failure. */
  async elevationM(lat: number, lng: number): Promise<number | null> {
    const h = await this.getHeader()
    if (h.tileType !== 2 /* PNG */) return null
    if (lng < h.minLon || lng > h.maxLon || lat < h.minLat || lat > h.maxLat) return null
    const { x, y, px, py } = latLngToTilePixel(lat, lng, h.maxZoom)
    const dem = await this.tile(h.maxZoom, x, y)
    if (!dem) return null
    return dem[py * TILE_PX + px]
  }

  async elevationFt(lat: number, lng: number): Promise<number | null> {
    const m = await this.elevationM(lat, lng)
    return m == null ? null : Math.round(m * FT_PER_M)
  }
}
