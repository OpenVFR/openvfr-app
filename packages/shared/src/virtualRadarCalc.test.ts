import { describe, it, expect } from 'vitest'

import { plannedAltitudeLine, DEFAULT_PERF_MODEL } from './virtualRadarCalc'
describe('plannedAltitudeLine on a short route', () => {
  const prof = [
    { distNm: 0, altFt: 1700 }, { distNm: 2.7, altFt: 1700 },
    { distNm: 2.7, altFt: 2000 }, { distNm: 5.43, altFt: 2000 },
    { distNm: 5.43, altFt: 3500 }, { distNm: 7.96, altFt: 3500 },
  ]
  it('keeps the climbs of earlier legs when the final descent does not fit', () => {
    const line = plannedAltitudeLine(prof, 7.96, DEFAULT_PERF_MODEL, 88, 245)
    // Not a straight line from departure to arrival: the early legs climb.
    expect(line.length).toBeGreaterThan(3)
    expect(Math.max(...line.map((p) => p.altFt))).toBeGreaterThan(1500)
    expect(line[0]).toEqual({ distNm: 0, altFt: 88 })
    expect(line[line.length - 1]).toEqual({ distNm: 7.96, altFt: 245 })
  })
  it('is unchanged when the descent fits', () => {
    const long = [{ distNm: 0, altFt: 3500 }, { distNm: 54, altFt: 3500 }]
    const line = plannedAltitudeLine(long, 54, DEFAULT_PERF_MODEL, 20, 20)
    expect(line.some((p) => p.altFt === 3500 && p.distNm > 10 && p.distNm < 45)).toBe(true)
    expect(line[line.length - 1].altFt).toBe(20)
  })
})
