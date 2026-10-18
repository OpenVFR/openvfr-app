import { describe, it, expect } from 'vitest'
import { legSpans, dragLevelFt, legMsaFt, levelLabel } from './legLevelDrag'

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
