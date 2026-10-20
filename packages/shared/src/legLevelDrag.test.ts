import { describe, it, expect } from 'vitest'
import { legSpans, dragLevelFt, legMsaFt, levelLabel, legMsaList, legBelowMsa } from './legLevelDrag'

describe('legSpans', () => {
  it('pairs profile points into legs', () => {
    const spans = legSpans([
      { distNm: 0, altFt: 3000 }, { distNm: 10, altFt: 3000 },
      { distNm: 10, altFt: 4500 }, { distNm: 25, altFt: 4500 },
    ])
    expect(spans).toEqual([
      { legIndex: 0, fromNm: 0, toNm: 10, altFt: 3000 },
      { legIndex: 1, fromNm: 10, toNm: 25, altFt: 4500 },
    ])
  })
})

describe('dragLevelFt', () => {
  const pxPerFt = 0.02 // 50 ft per px
  it('moves a quarter of the finger when dragging up', () => {
    // 80 px up -> 20 px effective -> +1000 ft
    expect(dragLevelFt(3000, -80, pxPerFt)).toBe(4000)
  })
  it('moves half of the finger when dragging down', () => {
    // 40 px down -> 20 px effective -> -1000 ft
    expect(dragLevelFt(3000, 40, pxPerFt)).toBe(2000)
  })
  it('snaps to 100 ft and caps', () => {
    expect(dragLevelFt(3000, -7, pxPerFt)).toBe(3100)
    expect(dragLevelFt(49_950, -400, pxPerFt)).toBe(50_000)
  })
  it('clears the override below the lowest step', () => {
    expect(dragLevelFt(300, 40, pxPerFt)).toBeNull()
  })
})

describe('legMsaFt', () => {
  it('takes the highest MSA inside the span', () => {
    const msa = [{ distNm: 0, msaFt: 2000 }, { distNm: 5, msaFt: 3500 }, { distNm: 12, msaFt: 2500 }]
    expect(legMsaFt(msa, 0, 10)).toBe(3500)
    expect(legMsaFt(msa, 11, 20)).toBe(2500)
    expect(legMsaFt(msa, 30, 40)).toBe(0)
  })
})

describe('levelLabel', () => {
  it('formats feet', () => { expect(levelLabel(3500)).toBe('3,500 ft') })
})

describe('legMsaList / legBelowMsa', () => {
  const spans = [
    { legIndex: 0, fromNm: 0, toNm: 20, altFt: 3000 },
    { legIndex: 1, fromNm: 20, toNm: 20.5, altFt: 3000 },
    { legIndex: 2, fromNm: 20.5, toNm: 50, altFt: 3000 },
  ]
  const pts = [
    { distNm: 0, msaFt: 1100 }, { distNm: 10, msaFt: 2500 }, { distNm: 20, msaFt: 1500 },
    { distNm: 30, msaFt: 3600 }, { distNm: 50, msaFt: 1000 },
  ]
  const at = (d: number) => [...pts].reverse().find((p) => p.distNm <= d)?.msaFt ?? 0
  it('takes the max inside each leg, midpoint for a leg with no sample', () => {
    expect(legMsaList(spans, pts, at)).toEqual([2500, 1500, 3600])
  })
  it('flags only legs below MSA away from the endpoints', () => {
    expect(legBelowMsa(spans[2], 50, 3000, 3600)).toBe(true)
    expect(legBelowMsa(spans[0], 50, 2000, 2500)).toBe(true)
    expect(legBelowMsa(spans[2], 50, 3600, 3600)).toBe(false)           // equal is fine
    expect(legBelowMsa(spans[2], 50, 3000, 0)).toBe(false)              // no MSA known
    expect(legBelowMsa({ legIndex: 0, fromNm: 0, toNm: 4, altFt: 500 }, 50, 500, 1100)).toBe(false) // departure
    expect(legBelowMsa({ legIndex: 3, fromNm: 46, toNm: 50, altFt: 500 }, 50, 500, 1100)).toBe(false) // arrival
  })
})
