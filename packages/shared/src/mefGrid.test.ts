import { describe, it, expect } from 'vitest'
import { zlibSync } from 'fflate'
import { parseMef, mefFtAt, corridorMaxFt, MEF_NODATA } from './mefGrid'

function make(codes: number[][], west = 12, north = 60.1, cell = 1 / 240, unitFt = 100): Uint8Array {
  const rows = codes.length, cols = codes[0].length
  const head = new ArrayBuffer(48)
  const dv = new DataView(head)
  new Uint8Array(head).set([0x4f, 0x4d, 0x45, 0x46])
  dv.setUint8(4, 1)
  dv.setUint16(6, unitFt, true)
  dv.setUint32(8, cols, true); dv.setUint32(12, rows, true)
  dv.setFloat64(16, west, true); dv.setFloat64(24, north, true)
  dv.setFloat64(32, cell, true); dv.setFloat64(40, cell, true)
  const body = zlibSync(Uint8Array.from(codes.flat()))
  const out = new Uint8Array(48 + body.length)
  out.set(new Uint8Array(head)); out.set(body, 48)
  return out
}

describe('parseMef / mefFtAt', () => {
  const N = MEF_NODATA
  const bytes = make([[1, 2, 3], [4, N, 6]])
  it('round-trips and looks up cells', () => {
    const g = parseMef(bytes)!
    expect(g.cols).toBe(3); expect(g.rows).toBe(2)
    const cell = 1 / 240
    expect(mefFtAt(g, 60.1 - 0.5 * cell, 12 + 0.5 * cell)).toBe(100)
    expect(mefFtAt(g, 60.1 - 0.5 * cell, 12 + 2.5 * cell)).toBe(300)
    expect(mefFtAt(g, 60.1 - 1.5 * cell, 12 + 1.5 * cell)).toBeNull() // no data
    expect(mefFtAt(g, 61, 12)).toBeNull()                             // outside
  })
  it('rejects garbage', () => {
    expect(parseMef(new Uint8Array(10))).toBeNull()
    expect(parseMef(bytes.subarray(0, 60))).toBeNull()
    const bad = bytes.slice(); bad[0] = 0
    expect(parseMef(bad)).toBeNull()
  })
})

describe('corridorMaxFt', () => {
  // 41x41 cells of 15" (~10 NM square): flat 100 ft, one 2 900 ft peak cell.
  const n = 41
  const rows = Array.from({ length: n }, () => Array<number>(n).fill(1))
  rows[20][35] = 29
  const g = parseMef(make(rows, 12, 60 + n / 240))!
  const cell = 1 / 240
  const lat = 60 + n / 240 - 20.5 * cell
  const lngAt = (c: number) => 12 + (c + 0.5) * cell
  const nmPerCellLng = cell * 60 * Math.cos((lat * Math.PI) / 180)

  it('sees a peak inside the radius but not far outside', () => {
    const farC = 35 - Math.ceil(8 / nmPerCellLng)   // ~8 NM west of the peak
    expect(corridorMaxFt([g], lat, lngAt(farC), 5)).toBe(100)
    const nearC = 35 - Math.floor(3 / nmPerCellLng) // ~3 NM west of the peak
    expect(corridorMaxFt([g], lat, lngAt(nearC), 5)).toBe(2900)
  })
  it('is null with no data and takes the max over several grids', () => {
    expect(corridorMaxFt([], lat, 12.05, 5)).toBeNull()
    const other = parseMef(make(rows.map((r) => r.map(() => 40)), 12, 60 + n / 240))!
    expect(corridorMaxFt([g, other], lat, lngAt(10), 5)).toBe(4000)
  })
})
