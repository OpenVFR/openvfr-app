import { describe, it, expect } from 'vitest'
import { applyTerrainToBands, type TerrainPoint } from './virtualRadarCalc'

const terrain: TerrainPoint[] = [
  { distNm: 0, elevFt: 200 }, { distNm: 5, elevFt: 1000 }, { distNm: 10, elevFt: 1800 }, { distNm: 15, elevFt: 600 },
]
const base = { entryNm: 4, exitNm: 11, class: 'MODEL', tag: 'M' }

describe('applyTerrainToBands', () => {
  it('leaves MSL/FL bands alone', () => {
    const b = [{ ...base, lower_ft: 0, upper_ft: 1500 }]
    expect(applyTerrainToBands(b, terrain)).toEqual(b)
  })
  it('no terrain → unchanged', () => {
    const b = [{ ...base, lower_ft: 0, upper_ft: 984, upperAgl: true }]
    expect(applyTerrainToBands(b, [])).toBe(b)
  })
  it('AGL ceiling sits on the highest terrain in the span', () => {
    const [r] = applyTerrainToBands([{ ...base, lower_ft: 0, upper_ft: 984, upperAgl: true }], terrain)
    expect(r.upper_ft).toBe(984 + 1800)
    expect(r.lower_ft).toBe(0)
  })
  it('AGL floor sits on the lowest terrain in the span', () => {
    const [r] = applyTerrainToBands([{ ...base, lower_ft: 1000, upper_ft: 9500, lowerAgl: true }], terrain)
    expect(r.lower_ft).toBe(1000 + 1000)
    expect(r.upper_ft).toBe(9500)
  })
  it('span between samples interpolates', () => {
    const [r] = applyTerrainToBands([{ ...base, entryNm: 6, exitNm: 7, lower_ft: 0, upper_ft: 500, upperAgl: true }], terrain)
    expect(r.upper_ft).toBeGreaterThan(500 + 1160); expect(r.upper_ft).toBeLessThan(500 + 1330)
  })
})
