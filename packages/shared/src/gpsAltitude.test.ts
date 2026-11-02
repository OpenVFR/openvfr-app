import { describe, it, expect } from 'vitest'
import { mslAltitudeFromFix } from './gpsAltitude'

describe('mslAltitudeFromFix', () => {
  const malmo = { lat: 55.536, lng: 13.376 }
  it('prefers the OS sea-level altitude', () => {
    expect(mslAltitudeFromFix({ ...malmo, altitude: 50, mslAltitude: 15 })).toEqual({ mslM: 15, source: 'os-msl' })
  })
  it('subtracts the geoid height from the ellipsoidal altitude when the OS has none', () => {
    const r = mslAltitudeFromFix({ ...malmo, altitude: 50.3, mslAltitude: null })!
    expect(r.source).toBe('geoid')
    expect(r.mslM).toBeCloseTo(15, 0) // geoid ~35.3 m at Malmö
  })
  it('uses altitude as sea level when the ground check says so', () => {
    expect(mslAltitudeFromFix({ ...malmo, altitude: 15, mslAltitude: null }, 'msl')).toEqual({ mslM: 15, source: 'raw' })
  })
  it('keeps the ellipsoidal value outside the geoid grid', () => {
    expect(mslAltitudeFromFix({ lat: 80, lng: 15, altitude: 20, mslAltitude: null })).toEqual({ mslM: 20, source: 'geoid' })
  })
  it('returns null without any altitude', () => {
    expect(mslAltitudeFromFix({ ...malmo, altitude: null, mslAltitude: null })).toBeNull()
  })
  it('ignores a non-finite OS value', () => {
    expect(mslAltitudeFromFix({ ...malmo, altitude: 50.3, mslAltitude: NaN })!.source).toBe('geoid')
  })
})
