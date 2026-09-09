import { describe, it, expect } from 'vitest'
import { pressureToAltitudeM, pressureToAltitudeFt, pickBestAltitudeSource, qnhFromStationPressure } from './baroAltitude'

describe('pressureToAltitudeM', () => {
  it('returns 0 at standard sea-level pressure (101325 Pa, QNH 1013.25)', () => {
    expect(pressureToAltitudeM(101325)).toBeCloseTo(0, 1)
  })

  it('returns 0 when pressure equals QNH datum, regardless of QNH value', () => {
    expect(pressureToAltitudeM(99000, 990)).toBeCloseTo(0, 1)
  })

  it('returns positive altitude when pressure is below QNH datum', () => {
    // ~1000m ISA pressure is roughly 89875 Pa
    expect(pressureToAltitudeM(89875)).toBeCloseTo(1000, -1)
  })

  it('shifts computed altitude when QNH is adjusted (same raw pressure)', () => {
    const lowQnh  = pressureToAltitudeM(101325, 990)
    const highQnh = pressureToAltitudeM(101325, 1030)
    expect(lowQnh).toBeLessThan(highQnh)
  })
})

describe('pressureToAltitudeFt', () => {
  it('matches pressureToAltitudeM converted to feet', () => {
    const m = pressureToAltitudeM(95000, 1013.25)
    expect(pressureToAltitudeFt(95000, 1013.25)).toBeCloseTo(m * 3.28084, 3)
  })
})

describe('qnhFromStationPressure', () => {
  it('recovers the original QNH used to compute a pressure at a known altitude', () => {
    const trueQnh = 1005.3
    const elevationM = 150
    const qnhPa = trueQnh * 100
    const pressurePa = qnhPa * Math.pow(1 - elevationM / 44301.59796, 1 / 0.190295)
    expect(qnhFromStationPressure(pressurePa, elevationM)).toBeCloseTo(trueQnh, 2)
  })

  it('returns the station pressure unchanged (as hPa) at elevation 0', () => {
    expect(qnhFromStationPressure(101325, 0)).toBeCloseTo(1013.25, 2)
  })

  it('is consistent with pressureToAltitudeM: feeding its own output back in gives altitude 0', () => {
    const qnhHpa = 995
    const elevationM = 300
    const pressurePa = qnhHpa * 100 * Math.pow(1 - elevationM / 44301.59796, 1 / 0.190295)
    const recoveredQnh = qnhFromStationPressure(pressurePa, elevationM)
    expect(pressureToAltitudeM(pressurePa, recoveredQnh)).toBeCloseTo(elevationM, 1)
  })
})

describe('pickBestAltitudeSource', () => {
  const base = {
    gpsAltFt: 1000,
    internalBaroPressureHpa: null,
    varioAltFt: null,
    varioVsFtMin: null,
    qnhHpa: 1013.25,
  }

  it('falls back to GPS when no barometric source is present', () => {
    const result = pickBestAltitudeSource(base)
    expect(result.tier).toBe('gps')
    expect(result.altFt).toBe(1000)
    expect(result.vsFtMin).toBeNull()
  })

  it('returns null altitude (not a crash) when GPS itself has no fix yet', () => {
    const result = pickBestAltitudeSource({ ...base, gpsAltFt: null })
    expect(result.tier).toBe('gps')
    expect(result.altFt).toBeNull()
  })

  it('prefers internal barometer over GPS when available', () => {
    const result = pickBestAltitudeSource({ ...base, internalBaroPressureHpa: 1013.25 })
    expect(result.tier).toBe('baro-internal')
    expect(result.altFt).toBeCloseTo(0, 1)
    expect(result.vsFtMin).toBeNull()
  })

  it('prefers BlueFly Vario over both internal barometer and GPS', () => {
    const result = pickBestAltitudeSource({
      ...base,
      internalBaroPressureHpa: 1013.25,
      varioAltFt: 2500,
      varioVsFtMin: 300,
    })
    expect(result.tier).toBe('baro-vario')
    expect(result.altFt).toBe(2500)
    expect(result.vsFtMin).toBe(300)
  })

  it('never populates vsFtMin for tiers other than baro-vario', () => {
    const gpsResult  = pickBestAltitudeSource(base)
    const baroResult = pickBestAltitudeSource({ ...base, internalBaroPressureHpa: 1000 })
    expect(gpsResult.vsFtMin).toBeNull()
    expect(baroResult.vsFtMin).toBeNull()
  })
})
