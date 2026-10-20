import { describe, it, expect } from 'vitest'
import { legSpans, dragLevelFt, legMsaFt, levelLabel, legMsaList, legBelowMsa, altAtY, unreachedLegs } from './legLevelDrag'

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
  it('follows the finger 1:1 up', () => {
    expect(dragLevelFt(3000, -20, pxPerFt)).toBe(4000)   // 20 px up -> +1000 ft
  })
  it('follows the finger 1:1 down', () => {
    expect(dragLevelFt(3000, 20, pxPerFt)).toBe(2000)
  })
  it('snaps to 100 ft and caps', () => {
    expect(dragLevelFt(3000, -2, pxPerFt)).toBe(3100)
    expect(dragLevelFt(49_950, -400, pxPerFt)).toBe(50_000)
  })
  it('below the lowest step clears the override', () => {
    expect(dragLevelFt(1000, 40, pxPerFt)).toBeNull()
  })
})

describe('altAtY', () => {
  it('reads the altitude drawn at a screen height', () => {
    expect(altAtY(900, 1000, 0.1)).toBe(1000)      // 100 px above ground, 10 ft/px
    expect(altAtY(1000, 1000, 0.1)).toBe(0)
    expect(altAtY(1100, 1000, 0.1)).toBe(0)        // below ground: never negative
    expect(altAtY(960, 1000, 0.1)).toBe(400)
  })
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

describe('unreachedLegs', () => {
  const spans = [
    { legIndex: 0, fromNm: 0, toNm: 3, altFt: 3500 },
    { legIndex: 1, fromNm: 3, toNm: 30, altFt: 3500 },
  ]
  const path = [
    { distNm: 0, altFt: 50 }, { distNm: 1.5, altFt: 700 }, { distNm: 3, altFt: 900 },
    { distNm: 10, altFt: 3500 }, { distNm: 20, altFt: 3500 }, { distNm: 30, altFt: 40 },
  ]
  it('flags a leg the path never gets near its level on', () => {
    expect(unreachedLegs(spans, path)).toEqual([{ legIndex: 0, levelFt: 3500, reachedFt: 900 }])
  })
  it('flags nothing when the path reaches the level', () => {
    expect(unreachedLegs([spans[1]], path)).toEqual([])
  })
})
