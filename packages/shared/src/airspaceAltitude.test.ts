import { describe, it, expect } from 'vitest'
import { limitIsFlightLevel, altitudeForLimit, limitIsAgl, effectiveLimitFt, limitMarginFt, insideBand, ALT_REF_UNCERTAIN_MARGIN_FT } from './airspaceAltitude'
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
  it('gps → identity at standard QNH', () => {
    expect(pickBestAltitudeSource({ gpsAltFt: 100, internalBaroPressureHpa: null, varioAltFt: null, varioVsFtMin: null, qnhHpa: 1013.25 }).stdAltFt).toBeCloseTo(100, 3)
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

describe('limitIsAgl / effectiveLimitFt', () => {
  it.each([['1500ft AGL', true], ['GND', true], ['SFC', true], ['300m GND', true], ['1500ft MSL', false], ['FL065', false], [null, false]])('%s', (s, e) => {
    expect(limitIsAgl(s as string | null)).toBe(e)
  })
  it('lifts AGL limits by terrain', () => expect(effectiveLimitFt('1500ft AGL', 1500, 1000)).toBe(2500))
  it('GND floor becomes terrain elevation', () => expect(effectiveLimitFt('GND', 0, 1000)).toBe(1000))
  it('leaves MSL/FL limits alone', () => {
    expect(effectiveLimitFt('2500ft MSL', 2500, 1000)).toBe(2500)
    expect(effectiveLimitFt('FL065', 6500, 1000)).toBe(6500)
  })
  it('raw value when terrain unknown', () => expect(effectiveLimitFt('1500ft AGL', 1500, null)).toBe(1500))
  it('never lowers a limit for below-sea-level terrain', () => expect(effectiveLimitFt('500ft AGL', 500, -20)).toBe(500))
})

describe('limitMarginFt', () => {
  it('zero when the reference matches', () => {
    expect(limitMarginFt('FL065', { qnhFt: 6500, stdFt: 6450 })).toBe(0)
    expect(limitMarginFt('4500ft MSL', { qnhFt: 6500, stdFt: 6450 })).toBe(0)
  })
  it('FL on QNH/GPS altitude', () => expect(limitMarginFt('FL065', { qnhFt: 6500, stdFt: null })).toBe(ALT_REF_UNCERTAIN_MARGIN_FT))
  it('unverified QNH', () => expect(limitMarginFt('4500ft MSL', { qnhFt: 6500, stdFt: 6450, qnhUncertain: true })).toBe(ALT_REF_UNCERTAIN_MARGIN_FT))
})

describe('insideBand', () => {
  it('strict band when not previously inside', () => {
    expect(insideBand(1490, 1490, 1500, 4500, false)).toBe(false)
    expect(insideBand(1500, 1500, 1500, 4500, false)).toBe(true)
  })
  it('keeps inside within hysteresis', () => {
    expect(insideBand(1450, 1450, 1500, 4500, true)).toBe(true)
    expect(insideBand(4550, 4550, 1500, 4500, true)).toBe(true)
    expect(insideBand(1390, 1390, 1500, 4500, true)).toBe(false)
  })
})

describe('pickBestAltitudeSource GPS stdAltFt', () => {
  it('derived from GPS altitude on a verified QNH', () => {
    const r = pickBestAltitudeSource({ gpsAltFt: 3000, internalBaroPressureHpa: null, varioAltFt: null, varioVsFtMin: null, qnhHpa: 1003.25, qnhCalibrated: true })
    expect(r.stdAltFt).toBeGreaterThan(3265); expect(r.stdAltFt).toBeLessThan(3285)
    expect(r.qnhCalibrated).toBe(true)
  })
  it('null on an unverified QNH', () => {
    expect(pickBestAltitudeSource({ gpsAltFt: 3000, internalBaroPressureHpa: null, varioAltFt: null, varioVsFtMin: null, qnhHpa: 1003.25, qnhCalibrated: false }).stdAltFt).toBeNull()
  })
})
