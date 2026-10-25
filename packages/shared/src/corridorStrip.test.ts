import { describe, it, expect } from 'vitest'
import { zlibSync } from 'fflate'
import { parseMef, type MefGrid } from './mefGrid'
import { corridorTerrainAlongRoute, computeMsaProfile, legCorridorMsaFt, getMsaLookup, type TerrainPoint } from './virtualRadarCalc'
import { legMsaList } from './legLevelDrag'
import { advancePosition } from './routeCalc'

// Flat 100 ft grid of 15" cells around 60N / 15E with single-cell peaks where asked.
const CELL = 1 / 240, WEST = 14.5, NORTH = 60.5, N = 480
function gridWith(peaks: { lat: number; lng: number; ft: number }[]): MefGrid {
  const codes = new Uint8Array(N * N).fill(1)
  for (const p of peaks) {
    const r = Math.floor((NORTH - p.lat) / CELL), c = Math.floor((p.lng - WEST) / CELL)
    codes[r * N + c] = Math.round(p.ft / 100)
  }
  const head = new ArrayBuffer(48)
  const dv = new DataView(head)
  new Uint8Array(head).set([0x4f, 0x4d, 0x45, 0x46]); dv.setUint8(4, 1); dv.setUint16(6, 100, true)
  dv.setUint32(8, N, true); dv.setUint32(12, N, true)
  dv.setFloat64(16, WEST, true); dv.setFloat64(24, NORTH, true); dv.setFloat64(32, CELL, true); dv.setFloat64(40, CELL, true)
  const body = zlibSync(codes)
  const out = new Uint8Array(48 + body.length); out.set(new Uint8Array(head)); out.set(body, 48)
  return parseMef(out)!
}
const at = (from: { lat: number; lng: number }, trk: number, nm: number) => advancePosition(from.lat, from.lng, trk, nm)
const samples = (totalNm: number, step: number): TerrainPoint[] => {
  const out: TerrainPoint[] = []
  for (let d = 0; d < totalNm - 1e-6; d += step) out.push({ distNm: Math.round(d * 100) / 100, elevFt: 100 })
  out.push({ distNm: totalNm, elevFt: 100 })
  return out
}

const A = { lat: 60, lng: 15 }
const B = at(A, 90, 20)                      // 20 NM east

describe('corridor: swept strip, not a circle per sample', () => {
  it('a peak 3 NM abeam raises only the samples it is abeam of', () => {
    const peak = at(at(A, 90, 10), 0, 3)     // 10 NM along, 3 NM north
    const g = gridWith([{ ...peak, ft: 2500 }])
    const pts = samples(20, 1)
    const c = corridorTerrainAlongRoute([A, B], pts, [g], { abeamNm: 5 })
    const high = pts.filter((_, i) => (c[i] ?? 0) >= 2500).map((p) => p.distNm)
    expect(Math.min(...high)).toBeGreaterThanOrEqual(8.5)
    expect(Math.max(...high)).toBeLessThanOrEqual(11.5)
    expect(c[0]).toBe(100)
    expect(c[pts.length - 1]).toBe(100)
  })

  it('a peak 6 NM abeam is outside a 5 NM corridor', () => {
    const g = gridWith([{ ...at(at(A, 90, 10), 0, 6), ft: 2500 }])
    const c = corridorTerrainAlongRoute([A, B], samples(20, 1), [g], { abeamNm: 5 })
    expect(Math.max(...c.map((v) => v ?? 0))).toBe(100)
  })

  it('no gaps: a single-cell peak between two widely spaced samples raises both, so the MSA lookup covers it', () => {
    const g = gridWith([{ ...at(A, 90, 9), ft: 3000 }])   // halfway between samples at 8 and 10 NM
    const pts = samples(20, 2)
    const c = corridorTerrainAlongRoute([A, B], pts, [g], { abeamNm: 5 })
    const i8 = pts.findIndex((p) => p.distNm === 8), i10 = pts.findIndex((p) => p.distNm === 10)
    expect(c[i8]).toBe(3000)
    expect(c[i10]).toBe(3000)
    const msa = computeMsaProfile(pts, { abeamNm: 5 }, undefined, c)
    expect(getMsaLookup(msa)(9)).toBeGreaterThanOrEqual(3000 + 800)
  })

  it('start cap: high ground just before the start counts at the first sample', () => {
    const g = gridWith([{ ...at(A, 270, 3), ft: 2000 }])
    const c = corridorTerrainAlongRoute([A, B], samples(20, 1), [g], { abeamNm: 5 })
    expect(c[0]).toBe(2000)
    expect(c[5]).toBe(100)
  })

  it('turn wedge: high ground outside a turn counts at the waypoint, nowhere else', () => {
    const W = at(A, 90, 10)
    const C = at(W, 0, 10)                   // left turn 90 deg at W
    const outside = at(at(W, 90, 3), 180, 3) // beyond both legs, ~4.2 NM from W
    const g = gridWith([{ ...outside, ft: 2200 }])
    const pts = samples(20, 1)
    const c = corridorTerrainAlongRoute([A, W, C], pts, [g], { abeamNm: 5 })
    const iW = pts.findIndex((p) => p.distNm === 10)
    expect(Math.max(c[iW - 1] ?? 0, c[iW] ?? 0, c[iW + 1] ?? 0)).toBe(2200)
    expect(c[3]).toBe(100)
    expect(c[17]).toBe(100)
  })
})

describe('leg MSA never lower than with a circle around every point', () => {
  it('high ground 4 NM into the next leg still counts for the previous leg', () => {
    const W = at(A, 90, 10)
    const C = at(W, 90, 10)
    const g = gridWith([{ ...at(W, 90, 4), ft: 3000 }])
    const floors = legCorridorMsaFt([A, W, C], [g], { abeamNm: 5 })
    expect(floors[0]).toBeGreaterThanOrEqual(3000 + 800)
    expect(floors[1]).toBeGreaterThanOrEqual(3000 + 800)
    const pts = samples(20, 1)
    const msa = computeMsaProfile(pts, { abeamNm: 5 }, undefined, corridorTerrainAlongRoute([A, W, C], pts, [g], { abeamNm: 5 }))
    const spans = [{ legIndex: 0, fromNm: 0, toNm: 10, altFt: 0 }, { legIndex: 1, fromNm: 10, toNm: 20, altFt: 0 }]
    expect(legMsaList(spans, msa, getMsaLookup(msa), floors)[0]).toBeGreaterThanOrEqual(3800)
  })

  it('obstacles raise only the stretch they are abeam of, but the whole leg MSA', () => {
    const pts = samples(20, 1)
    const g = gridWith([])
    const obstacles = [{ distNm: 10, elevationFt: 1200 }]
    const msa = computeMsaProfile(pts, { abeamNm: 5 }, obstacles, corridorTerrainAlongRoute([A, B], pts, [g], { abeamNm: 5 }))
    const look = getMsaLookup(msa)
    expect(look(10)).toBeGreaterThanOrEqual(1200 + 1000)
    expect(look(3)).toBeLessThan(1200)
    expect(legCorridorMsaFt([A, B], [g], { abeamNm: 5 }, obstacles)[0]).toBeGreaterThanOrEqual(2200)
  })

  it('without a grid: unchanged conservative window along the centreline', () => {
    const pts = samples(20, 1).map((p) => (p.distNm === 10 ? { ...p, elevFt: 2000 } : p))
    const msa = computeMsaProfile(pts, { abeamNm: 5 }, undefined, pts.map(() => null))
    expect(getMsaLookup(msa)(6)).toBeGreaterThanOrEqual(2800)
    expect(legCorridorMsaFt([A, B], [], { abeamNm: 5 })[0]).toBe(0)
  })
})
