import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { zlibSync } from 'fflate'
import { PmtilesDem, decodeTerrariumPng, latLngToTilePixel, type RangeSource } from './terrainDem'

// ── Synthetic PNG helpers ─────────────────────────────────────────────────
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set([...type].map(ch => ch.charCodeAt(0)), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
/** 256x256 RGB Terrarium PNG where every pixel encodes `elevM(x,y)`; filter type per row. */
function terrariumPng(elevM: (x: number, y: number) => number, filter = 0, channels = 3): Uint8Array {
  const w = 256, h = 256, stride = w * channels
  const raw = new Uint8Array((stride + 1) * h)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const cur = new Uint8Array(stride)
    for (let x = 0; x < w; x++) {
      const v = elevM(x, y) + 32768
      cur[x * channels] = Math.floor(v / 256); cur[x * channels + 1] = Math.floor(v) % 256; cur[x * channels + 2] = Math.round((v % 1) * 256) % 256
      if (channels === 4) cur[x * channels + 3] = 255
    }
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0
      let f: number
      if (filter === 0) f = cur[x]
      else if (filter === 1) f = cur[x] - a
      else if (filter === 2) f = cur[x] - b
      else if (filter === 3) f = cur[x] - ((a + b) >> 1)
      else { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); f = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) }
      raw[y * (stride + 1) + 1 + x] = f & 0xff
    }
    prev = cur
  }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

describe('decodeTerrariumPng', () => {
  it.each([0, 1, 2, 3, 4])('round-trips with filter %i', (filter) => {
    const dem = decodeTerrariumPng(terrariumPng((x, y) => x * 4 + y - 100, filter))!
    expect(dem).not.toBeNull()
    expect(dem[0]).toBe(-100)
    expect(dem[10 * 256 + 20]).toBe(20 * 4 + 10 - 100)
    expect(dem[255 * 256 + 255]).toBe(255 * 4 + 255 - 100)
  })
  it('RGBA', () => expect(decodeTerrariumPng(terrariumPng(() => 1234, 0, 4))![5]).toBe(1234))
  it('rejects non-PNG and wrong geometry', () => {
    expect(decodeTerrariumPng(new Uint8Array(40))).toBeNull()
    const png = terrariumPng(() => 1); png[25] = 3 // palette
    expect(decodeTerrariumPng(png)).toBeNull()
  })
})

describe('latLngToTilePixel', () => {
  it('Stockholm z10', () => {
    const t = latLngToTilePixel(59.33, 18.07, 10)
    expect(t.x).toBe(563); expect(t.y).toBe(301)
    expect(t.px).toBeGreaterThanOrEqual(0); expect(t.px).toBeLessThan(256)
  })
})

// ── Real archive, when present (web public tiles are gitignored data) ─────
const archive = path.resolve(__dirname, '../../../apps/web/public/tiles/se-hillshade.pmtiles')
const haveArchive = fs.existsSync(archive)

describe.skipIf(!haveArchive)('PmtilesDem against se-hillshade.pmtiles', () => {
  let maxRead = 0
  // describe bodies run even when skipped: don't open a missing file (CI)
  const fd = haveArchive ? fs.openSync(archive, 'r') : -1
  const source: RangeSource = {
    getKey: () => archive,
    async getBytes(offset, length) {
      maxRead = Math.max(maxRead, length)
      const b = Buffer.alloc(length)
      fs.readSync(fd, b, 0, length, offset)
      return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) }
    },
  }
  const dem = new PmtilesDem(source)

  it('Kebnekaise summit area is high', async () => {
    const ft = await dem.elevationFt(67.90, 18.52)
    expect(ft).not.toBeNull(); expect(ft!).toBeGreaterThan(4000)
  })
  it('Stockholm archipelago is near sea level', async () => {
    const ft = await dem.elevationFt(59.33, 18.07)
    expect(ft).not.toBeNull(); expect(ft!).toBeLessThan(300); expect(ft!).toBeGreaterThan(-50)
  })
  it('outside coverage → null', async () => {
    expect(await dem.elevationFt(48.0, 2.0)).toBeNull()
  })
  it('never reads more than one tile at a time', () => {
    expect(maxRead).toBeLessThan(512 * 1024)
  })
})
