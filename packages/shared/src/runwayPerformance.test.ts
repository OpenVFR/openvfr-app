import { describe, it, expect } from 'vitest'
import { requiredDistanceM, parseMetarTempC, bestRunwayFit, runwaysAllowStop, runwayShortfalls, runwaysByIcao } from './runwayPerformance'

const p = { takeoffDist50ftM: 400, landingDist50ftM: 350 }

describe('requiredDistanceM', () => {
  it('applies only the safety factor at sea level, ISA, paved', () => {
    expect(requiredDistanceM(p, 'takeoff', { elevationFt: 0, surface: 'ASPH' })).toBe(532)
    expect(requiredDistanceM(p, 'landing', { elevationFt: 0, surface: 'CONC' })).toBe(501)
  })
  it('adds elevation, heat and grass', () => {
    // 2,000 ft: +20 %; ISA there 11 °C, 31 °C is 20 above: +20 %; grass +20 %
    expect(requiredDistanceM(p, 'takeoff', { elevationFt: 2000, surface: 'GRASS', tempC: 31 })).toBe(Math.round(400 * 1.2 * (1 + 0.1 * (31 - (15 - 3.96)) / 10) * 1.2 * 1.33))
    // Cold does not shorten it
    expect(requiredDistanceM(p, 'takeoff', { elevationFt: 0, surface: 'ASPH', tempC: -10 })).toBe(532)
  })
  it('is null without a distance', () => {
    expect(requiredDistanceM({}, 'takeoff', { elevationFt: 0, surface: 'ASPH' })).toBeNull()
  })
})

describe('parseMetarTempC', () => {
  it('reads the temperature group', () => {
    expect(parseMetarTempC('ESSB 111020Z 24012KT 9999 FEW030 08/03 Q1013')).toBe(8)
    expect(parseMetarTempC('ESNQ 111020Z 00000KT CAVOK M12/M15 Q1030')).toBe(-12)
    expect(parseMetarTempC('ESSB 111020Z 24012KT 9999 Q1013')).toBeNull()
  })
})

describe('runway fit', () => {
  const rwys = [{ designator: '03/21', lengthM: 500, surface: 'GRASS' }, { designator: '12/30', lengthM: 600, surface: 'ASPH' }]
  it('picks the runway with most to spare', () => {
    const f = bestRunwayFit(p, 'takeoff', rwys, 0)!
    expect(f.runway.designator).toBe('12/30')
    expect(f.ok).toBe(true)
  })
  it('a stop needs both landing and take-off', () => {
    expect(runwaysAllowStop(p, rwys, 0)).toBe(true)
    expect(runwaysAllowStop({ takeoffDist50ftM: 500, landingDist50ftM: 350 }, rwys, 0)).toBe(false)
    expect(runwaysAllowStop({}, [{ lengthM: 100, surface: 'GRASS' }], 0)).toBe(true)
  })
  it('lists shortfalls at route aerodromes', () => {
    const ads = runwaysByIcao({ features: [{ properties: { icao: 'ESXX', elevation_ft: 1000, runways: [{ designator: '09/27', length_m: 550, surface: 'ASPH' }] } }] })
    const r = runwayShortfalls(p, [{ icao: 'ESXX', role: 'destination', ops: ['landing'] }, { icao: 'ESXX', role: 'departure', ops: ['takeoff'] }], ads)
    // 1,000 ft: landing 350 x 1.1 x 1.43 = 551 m, take-off 400 x 1.1 x 1.33 = 585 m; runway 550 m
    expect(r.map(x => [x.op, x.requiredM])).toEqual([['landing', 551], ['takeoff', 585]])
    expect(runwayShortfalls(p, [{ icao: 'ESXX', role: 'destination', ops: ['landing'] }], ads, new Map())).toHaveLength(1)
    expect(runwayShortfalls({}, [{ icao: 'ESXX', role: 'destination', ops: ['landing'] }], ads)).toEqual([])
  })
})
