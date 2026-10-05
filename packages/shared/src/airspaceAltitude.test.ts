import { describe, it, expect } from 'vitest'
import { limitIsFlightLevel, altitudeForLimit } from './airspaceAltitude'
import { qnhAltToStdAltFt, pickBestAltitudeSource, pressureToAltitudeFt } from './baroAltitude'

describe('limitIsFlightLevel', () => {
  it.each([['FL065', true], ['fl95', true], ['1500ft MSL', false], ['SFC', false], ['300m AGL', false], [null, false]])('%s', (s, e) => {
    expect(limitIsFlightLevel(s as string | null)).toBe(e)
  })
})

describe('altitudeForLimit', () => {
  const alt = { qnhFt: 6500, stdFt: 6450 }
  it('FL uses std', () => expect(altitudeForLimit('FL065', alt)).toBe(6450))
  it('MSL uses QNH', () => expect(altitudeForLimit('4500ft MSL', alt)).toBe(6500))
  it('FL falls back to QNH without baro', () => expect(altitudeForLimit('FL065', { qnhFt: 6500, stdFt: null })).toBe(6500))
})

describe('qnhAltToStdAltFt', () => {
  it('identity at QNH 1013.25', () => expect(qnhAltToStdAltFt(3000, 1013.25)).toBeCloseTo(3000, 3))
  it('~27 ft per hPa: high QNH → lower pressure altitude', () => {
    expect(qnhAltToStdAltFt(0, 1023.25)).toBeGreaterThan(-285); expect(qnhAltToStdAltFt(0, 1023.25)).toBeLessThan(-265)
    expect(qnhAltToStdAltFt(0, 1003.25)).toBeGreaterThan(265)
  })
  it('matches direct pressure computation', () => {
    const p = 85000
    expect(qnhAltToStdAltFt(pressureToAltitudeFt(p, 1020), 1020)).toBeCloseTo(pressureToAltitudeFt(p), 3)
  })
})

describe('pickBestAltitudeSource stdAltFt', () => {
  it('gps → null', () => {
    expect(pickBestAltitudeSource({ gpsAltFt: 100, internalBaroPressureHpa: null, varioAltFt: null, varioVsFtMin: null, qnhHpa: 1013.25 }).stdAltFt).toBeNull()
  })
  it('internal → pressure altitude', () => {
    const r = pickBestAltitudeSource({ gpsAltFt: 0, internalBaroPressureHpa: 900, varioAltFt: null, varioVsFtMin: null, qnhHpa: 1020 })
    expect(r.stdAltFt).toBeCloseTo(pressureToAltitudeFt(90000), 3)
  })
  it('vario → re-referenced', () => {
    const r = pickBestAltitudeSource({ gpsAltFt: 0, internalBaroPressureHpa: null, varioAltFt: 1000, varioVsFtMin: 0, qnhHpa: 1013.25 })
    expect(r.stdAltFt).toBeCloseTo(1000, 3)
  })
})
