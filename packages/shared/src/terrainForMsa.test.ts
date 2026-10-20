import { describe, it, expect } from 'vitest'
import { zlibSync } from 'fflate'
import { parseMef } from './mefGrid'
import { terrainForMsa, computeMsaProfile } from './virtualRadarCalc'

// 60x60 cells of 15" (~15 NM square) at 60N, flat 100 ft with a 2 900 ft ridge around lng 15.15.
function grid() {
  const n = 120, cell = 1 / 240
  const codes = new Uint8Array(n * n).fill(1)
  const west = 15, north = 60.25
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const lng = west + (c + 0.5) * cell
    if (lng > 15.14 && lng < 15.16) codes[r * n + c] = 29
  }
  const head = new ArrayBuffer(48)
  const dv = new DataView(head)
  new Uint8Array(head).set([0x4f, 0x4d, 0x45, 0x46]); dv.setUint8(4, 1); dv.setUint16(6, 100, true)
  dv.setUint32(8, n, true); dv.setUint32(12, n, true)
  dv.setFloat64(16, west, true); dv.setFloat64(24, north, true); dv.setFloat64(32, cell, true); dv.setFloat64(40, cell, true)
  const body = zlibSync(codes)
  const out = new Uint8Array(48 + body.length); out.set(new Uint8Array(head)); out.set(body, 48)
  return parseMef(out)!
}

const route = [{ lat: 60, lng: 15.0 }, { lat: 60, lng: 15.5 }]   // ~15 NM east

describe('terrainForMsa', () => {
  const g = grid()
  it('uses the fetched terrain when there is some', () => {
    const t = terrainForMsa(route, [{ distNm: 0, elevFt: 50 }, { distNm: 15, elevFt: 60 }], [g], null, true)
    expect(t.fromGridOnly).toBe(false)
    expect(t.pts).toHaveLength(2)
    expect(t.corridorFt).toHaveLength(2)
  })
  it('is empty while the fetch is still running, even with a grid', () => {
    expect(terrainForMsa(route, [], [g], null, false)).toEqual({ pts: [], corridorFt: [], fromGridOnly: false })
  })
  it('is empty without a grid or outside it', () => {
    expect(terrainForMsa(route, [], [], null, true).pts).toEqual([])
    expect(terrainForMsa([{ lat: 40, lng: 5 }, { lat: 40, lng: 5.5 }], [], [g], null, true).pts).toEqual([])
  })
  it('after a failed fetch builds route samples from the grid and an MSA from them', () => {
    const t = terrainForMsa(route, [], [g], null, true)
    expect(t.fromGridOnly).toBe(true)
    expect(t.pts.length).toBeGreaterThanOrEqual(10)
    expect(t.pts[0].distNm).toBe(0)
    const msa = computeMsaProfile(t.pts, null, undefined, t.corridorFt)
    const near = msa.find((m) => m.distNm > 6 && m.distNm < 9)!      // beside the ridge
    const first = msa[0]                                              // 4.5 NM from the ridge: inside the 5 NM corridor
    const away = msa[msa.length - 1]                                  // ~10 NM from it, flat
    expect(near.msaFt).toBeGreaterThanOrEqual(2900 + 800)             // ridge + terrain clearance
    expect(first.msaFt).toBeGreaterThanOrEqual(2900 + 800)
    expect(away.msaFt).toBe(900)                                      // flat 100 ft + 800 ft clearance
  })
})
