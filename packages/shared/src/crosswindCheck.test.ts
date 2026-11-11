import { describe, it, expect } from 'vitest'
import { crosswindExceedances, thresholdsByIcao } from './crosswindCheck'
import type { ParsedWind } from './fetchWx'

const fc = {
  features: [{
    properties: {
      icao: 'ESXX',
      runways: [{ thresholds: [
        { designator: '09', mag_brg: 90, true_brg: 92 },
        { designator: '27', mag_brg: 270, true_brg: 272 },
      ] }],
    },
  }],
}
const ths = thresholdsByIcao(fc)
const w = (dirDeg: number, speedKt: number, gustKt: number | null = null): ParsedWind =>
  ({ dirDeg, speedKt, gustKt, variable: false, calm: false })

describe('crosswindExceedances', () => {
  it('reads thresholds', () => {
    expect(ths.get('ESXX')?.map(t => t.designator)).toEqual(['09', '27'])
  })
  it('flags a crosswind above the limit on the best runway', () => {
    const r = crosswindExceedances([{ icao: 'ESXX', role: 'destination' }], new Map([['ESXX', w(180, 20)]]), ths, 15)
    expect(r).toHaveLength(1)
    expect(r[0].crosswindKt).toBe(20)
    expect(r[0].windText).toBe('180/20 kt')
  })
  it('uses the gust', () => {
    expect(crosswindExceedances([{ icao: 'ESXX', role: 'departure' }], new Map([['ESXX', w(180, 10, 18)]]), ths, 15)).toHaveLength(1)
  })
  it('passes when a runway is nearly into wind', () => {
    expect(crosswindExceedances([{ icao: 'ESXX', role: 'departure' }], new Map([['ESXX', w(100, 25)]]), ths, 15)).toEqual([])
  })
  it('skips without a limit, wind or runway data', () => {
    expect(crosswindExceedances([{ icao: 'ESXX', role: 'x' }], new Map([['ESXX', w(180, 30)]]), ths, 0)).toEqual([])
    expect(crosswindExceedances([{ icao: 'ESYY', role: 'x' }], new Map([['ESYY', w(180, 30)]]), ths, 15)).toEqual([])
    expect(crosswindExceedances([{ icao: 'ESXX', role: 'x' }], new Map(), ths, 15)).toEqual([])
  })
})
