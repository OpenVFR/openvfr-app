import { describe, it, expect } from 'vitest'
import { iasToTas, tasToIas, isaTempC } from './airspeed'

describe('airspeed', () => {
  it('sea level ISA: TAS = IAS', () => expect(iasToTas(100, 0)).toBeCloseTo(100, 6))
  it('~2% per 1000 ft', () => {
    expect(iasToTas(100, 5000)).toBeGreaterThan(107)
    expect(iasToTas(100, 5000)).toBeLessThan(109)
    expect(iasToTas(100, 10000)).toBeGreaterThan(116)
    expect(iasToTas(100, 10000)).toBeLessThan(118)
  })
  it('hotter air raises TAS', () => expect(iasToTas(100, 5000, 30)).toBeGreaterThan(iasToTas(100, 5000)))
  it('round trip', () => expect(tasToIas(iasToTas(95, 7500), 7500)).toBeCloseTo(95, 6))
  it('passes through zero / invalid', () => { expect(iasToTas(0, 5000)).toBe(0); expect(iasToTas(-5, 5000)).toBe(-5) })
  it('ISA temperature', () => { expect(isaTempC(0)).toBe(15); expect(isaTempC(10000)).toBeCloseTo(-4.8, 5) })
})
