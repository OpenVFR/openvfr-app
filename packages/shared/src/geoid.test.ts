import { describe, it, expect } from 'vitest'
import { geoidHeightM, ellipsoidToMslM, gpsAltitudeIsEllipsoidal } from './geoid'

describe('geoidHeightM', () => {
  // Reference: EGM96 15' model (GeographicLib egm96-15.pgm), bilinear.
  const ref: [string, number, number, number][] = [
    ['ESMS Malmö', 55.536, 13.376, 35.3],
    ['ESGG Göteborg', 57.663, 12.280, 35.7],
    ['ESSA Arlanda', 59.652, 17.919, 23.2],
    ['ESNQ Kiruna', 67.822, 20.337, 29.9],
    ['ESPA Luleå', 65.544, 22.122, 21.6],
    ['ENGM Oslo', 60.194, 11.100, 38.3],
    ['EFHK Helsinki', 60.317, 24.963, 17.9],
  ]
  for (const [name, lat, lng, n] of ref) {
    it(`matches EGM96 at ${name} within 1 m`, () => {
      expect(geoidHeightM(lat, lng)!).toBeCloseTo(n, 0)
    })
  }
  it('returns null outside the covered area', () => {
    expect(geoidHeightM(80, 15)).toBeNull()
    expect(geoidHeightM(30, 15)).toBeNull()
    expect(geoidHeightM(59, 60)).toBeNull()
  })
  it('covers the grid edges', () => {
    expect(geoidHeightM(72, -25)).not.toBeNull()
    expect(geoidHeightM(34, 45)).not.toBeNull()
  })
})

describe('ellipsoidToMslM', () => {
  it('subtracts the geoid height', () => {
    // A GPS ellipsoidal height of 350 m at Arlanda is ~327 m AMSL.
    expect(ellipsoidToMslM(350, 59.652, 17.919)).toBeCloseTo(326.8, 0)
  })
  it('leaves the value alone outside the grid', () => {
    expect(ellipsoidToMslM(350, 80, 15)).toBe(350)
  })
})

describe('gpsAltitudeIsEllipsoidal', () => {
  it('is true on Android only', () => {
    expect(gpsAltitudeIsEllipsoidal({ os: 'android' })).toBe(true)
    expect(gpsAltitudeIsEllipsoidal({ os: 'ios' })).toBe(false)
    expect(gpsAltitudeIsEllipsoidal({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130' })).toBe(true)
    expect(gpsAltitudeIsEllipsoidal({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari' })).toBe(false)
    expect(gpsAltitudeIsEllipsoidal({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' })).toBe(false)
  })
})
