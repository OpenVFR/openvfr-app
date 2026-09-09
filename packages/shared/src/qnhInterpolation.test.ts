import { describe, it, expect } from 'vitest'
import { interpolateQnh } from './qnhInterpolation'

describe('interpolateQnh', () => {
  it('returns null for empty input', () => {
    expect(interpolateQnh([])).toBeNull()
  })

  it('returns the exact value for a single reading regardless of distance', () => {
    const result = interpolateQnh([{ icao: 'ESSA', distNm: 12, qnhHpa: 1013 }])
    expect(result?.qnhHpa).toBeCloseTo(1013, 5)
    expect(result?.stations).toEqual(['ESSA'])
  })

  it('weights closer stations more heavily than farther ones', () => {
    // ESSA very close with 1000, ESGG far away with 1020 — result should be
    // much closer to 1000 than a plain average (1010) would suggest.
    const result = interpolateQnh([
      { icao: 'ESSA', distNm: 2,  qnhHpa: 1000 },
      { icao: 'ESGG', distNm: 100, qnhHpa: 1020 },
    ])
    expect(result).not.toBeNull()
    expect(result!.qnhHpa).toBeLessThan(1005)
    expect(result!.qnhHpa).toBeGreaterThan(1000)
  })

  it('produces the simple average when all distances are equal', () => {
    const result = interpolateQnh([
      { icao: 'A', distNm: 10, qnhHpa: 1000 },
      { icao: 'B', distNm: 10, qnhHpa: 1020 },
    ])
    expect(result?.qnhHpa).toBeCloseTo(1010, 5)
  })

  it('sorts stations nearest-first regardless of input order', () => {
    const result = interpolateQnh([
      { icao: 'FAR',  distNm: 80, qnhHpa: 1010 },
      { icao: 'NEAR', distNm: 5,  qnhHpa: 1012 },
    ])
    expect(result?.stations).toEqual(['NEAR', 'FAR'])
  })

  it('never divides by zero for a station at distance 0', () => {
    const result = interpolateQnh([{ icao: 'ESSA', distNm: 0, qnhHpa: 1013 }])
    expect(result?.qnhHpa).toBeCloseTo(1013, 5)
    expect(Number.isFinite(result?.qnhHpa)).toBe(true)
  })

  it('handles three stations with a realistic spread', () => {
    const result = interpolateQnh([
      { icao: 'A', distNm: 5,  qnhHpa: 1015 },
      { icao: 'B', distNm: 20, qnhHpa: 1013 },
      { icao: 'C', distNm: 50, qnhHpa: 1008 },
    ])
    expect(result).not.toBeNull()
    // Closest station (1015) should dominate, so result should sit closer to
    // 1015 than the unweighted mean of ~1012.
    expect(result!.qnhHpa).toBeGreaterThan(1012)
  })
})
