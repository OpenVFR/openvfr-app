import { describe, it, expect } from 'vitest'
import { effectiveHeight, obstacleTipsForMsa, ESTIMATED_HEIGHT_M, FT_PER_M } from './obstacleHeights'

describe('effectiveHeight', () => {
  it('keeps a known height', () => {
    expect(effectiveHeight('mast', 120)).toEqual({ heightM: 120, estimated: false })
  })
  it('estimates an unknown one per kind, with a fallback', () => {
    expect(effectiveHeight('wind_turbine', 0)).toEqual({ heightM: ESTIMATED_HEIGHT_M.wind_turbine, estimated: true })
    expect(effectiveHeight('mast', undefined).estimated).toBe(true)
    expect(effectiveHeight('something_new', null)).toEqual({ heightM: 60, estimated: true })
  })
})

describe('obstacleTipsForMsa', () => {
  it('adds the height to the ground, not just the ground elevation', () => {
    const tips = obstacleTipsForMsa([{ distNm: 5, kind: 'building', elevationFt: 43, heightM: 75 }], [], () => 0)
    expect(tips[0].elevationFt).toBe(Math.round(43 + 75 * FT_PER_M))   // 289
    expect(tips[0].estimated).toBe(false)
  })
  it('uses the terrain when it is higher than the surveyed elevation', () => {
    const tips = obstacleTipsForMsa([{ distNm: 5, kind: 'tower', elevationFt: 0, heightM: 50 }], [], () => 1000)
    expect(tips[0].elevationFt).toBe(Math.round(1000 + 50 * FT_PER_M))
  })
  it('gives unknown heights the estimate and flags it, landmarks included', () => {
    const tips = obstacleTipsForMsa(
      [{ distNm: 1, kind: 'wind_turbine', elevationFt: 100, heightM: 0 }],
      [{ distNm: 2, kind: 'mast' }, { distNm: 3, kind: 'church', heightM: 40 }],
      () => 200,
    )
    expect(tips.map((t) => t.estimated)).toEqual([true, true, false])
    expect(tips[0].elevationFt).toBe(Math.round(200 + 135 * FT_PER_M))
    expect(tips[1].elevationFt).toBe(Math.round(200 + 91 * FT_PER_M))
    expect(tips[2].elevationFt).toBe(Math.round(200 + 40 * FT_PER_M))
  })
})

import { limitingObstacleLabel } from './obstacleHeights'
describe('limitingObstacleLabel', () => {
  it('uses the name, else the kind, with the tip altitude and an estimate mark', () => {
    expect(limitingObstacleLabel('building', 'Kronprinsen', 289, false)).toBe('Kronprinsen 289 ft')
    expect(limitingObstacleLabel('wind_turbine', '', 944, true)).toBe("944'")
    expect(limitingObstacleLabel('tower', undefined, 1500, false)).toBe("1,500'")
    expect(limitingObstacleLabel('tower', 'Älvsborgsbron', 1096, false)).toBe('Älvsborgsbron 1,096 ft')
  })
  it('drops a leading code and shortens long names', () => {
    expect(limitingObstacleLabel('tower', '70939S1 - Vaxtuna', 500, false)).toBe('Vaxtuna 500 ft')
    expect(limitingObstacleLabel('tower', 'A very long mast name indeed', 500, false)).toBe('A very long mast… 500 ft')
  })
})
