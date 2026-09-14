import { describe, it, expect } from 'vitest'
import { effectiveMagBrg, computeRunwayWind } from './runwayWind'
import type { ParsedWind } from './fetchWx'

function wind(dirDeg: number, speedKt: number, gustKt: number | null = null): ParsedWind {
  return { dirDeg, speedKt, gustKt, variable: false, calm: false }
}

describe('effectiveMagBrg', () => {
  it('returns a real (nonzero) mag_brg unchanged', () => {
    expect(effectiveMagBrg(169, 173)).toBe(169)
  })

  it('falls back to true_brg when mag_brg is the 0 placeholder', () => {
    // Real-world case: ESMI runway 12, mag_brg=0 (not yet computed),
    // true_brg=129 — must NOT render/compute as if heading were 0/north.
    expect(effectiveMagBrg(0, 129)).toBe(129)
  })

  it('returns null when neither value is available', () => {
    expect(effectiveMagBrg(0, null)).toBeNull()
    expect(effectiveMagBrg(null, null)).toBeNull()
    expect(effectiveMagBrg(null, undefined)).toBeNull()
  })

  it('does not treat a missing mag_brg (null) differently from a placeholder (0) — both fall back', () => {
    expect(effectiveMagBrg(null, 309)).toBe(309)
  })
})

describe('computeRunwayWind', () => {
  const rwy12_30 = [
    { designator: '12', mag_brg: 0, true_brg: 129 },   // placeholder mag_brg, like ESMI
    { designator: '30', mag_brg: 0, true_brg: 309 },
  ]

  it('returns null components for every end when wind is calm', () => {
    const ends = computeRunwayWind(rwy12_30, { dirDeg: null, speedKt: 0, gustKt: null, variable: false, calm: true })
    expect(ends).toHaveLength(2)
    for (const e of ends) {
      expect(e.headwindKt).toBeNull()
      expect(e.crosswindKt).toBeNull()
      expect(e.favored).toBe(false)
    }
  })

  it('returns null components when wind is null', () => {
    const ends = computeRunwayWind(rwy12_30, null)
    expect(ends.every((e) => e.headwindKt === null)).toBe(true)
  })

  it('resolves bearing via true_brg fallback and computes correct headwind/crosswind', () => {
    // Wind straight down runway 12's approach direction (129°) at 10 kt —
    // pure headwind on 12, pure tailwind on 30, zero crosswind on both.
    const ends = computeRunwayWind(rwy12_30, wind(129, 10))
    const e12 = ends.find((e) => e.designator === '12')!
    const e30 = ends.find((e) => e.designator === '30')!
    expect(e12.magBrgDeg).toBe(129) // fell back to true_brg, not the 0 placeholder
    expect(e12.headwindKt).toBe(10)
    expect(e12.crosswindKt).toBe(0)
    expect(e30.headwindKt).toBe(-10)
    expect(e30.crosswindKt).toBe(0)
  })

  it('marks the end with the higher headwind component as favored', () => {
    const ends = computeRunwayWind(rwy12_30, wind(129, 10))
    const e12 = ends.find((e) => e.designator === '12')!
    const e30 = ends.find((e) => e.designator === '30')!
    expect(e12.favored).toBe(true)
    expect(e30.favored).toBe(false)
  })

  it('computes a 90°-crosswind case with ~zero headwind', () => {
    // Wind at 219° (90° off runway 12/30's 129° heading) — pure crosswind.
    const ends = computeRunwayWind(rwy12_30, wind(219, 15))
    const e12 = ends.find((e) => e.designator === '12')!
    expect(e12.headwindKt).toBeCloseTo(0, 0)
    expect(e12.crosswindKt).toBeCloseTo(15, 0)
  })

  it('leaves an end null when it has no resolvable bearing at all', () => {
    const ends = computeRunwayWind(
      [{ designator: '09', mag_brg: null, true_brg: null }, { designator: '27', mag_brg: 0, true_brg: 270 }],
      wind(270, 10),
    )
    const e09 = ends.find((e) => e.designator === '09')!
    const e27 = ends.find((e) => e.designator === '27')!
    expect(e09.headwindKt).toBeNull()
    expect(e27.headwindKt).toBe(10)
  })
})
