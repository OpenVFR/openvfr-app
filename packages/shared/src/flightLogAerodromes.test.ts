import { describe, it, expect } from 'vitest'
import { aerodromeNear, logEndAerodromes, missingLogAerodromes, normalizeLogPlace } from './flightLogAerodromes'

// Two aerodromes ~20 NM apart.
const AD = [
  { icao: 'ESMI', lat: 56.8, lng: 14.3 },
  { icao: 'ESMX', lat: 56.93, lng: 14.73 },
  { icao: '', lat: 56.81, lng: 14.3 },   // no code: never named
]
const at = (lat: number, lng: number, spdKts: number) => ({ lat, lng, spdKts })

describe('aerodromeNear', () => {
  it('names the nearest aerodrome within range', () => {
    expect(aerodromeNear(56.805, 14.31, AD)).toBe('ESMI')
  })
  it('names none farther than the limit', () => {
    expect(aerodromeNear(57.2, 14.3, AD)).toBe('')
  })
})

describe('missingLogAerodromes', () => {
  const round = [at(56.8, 14.3, 60), at(56.9, 14.5, 100), at(56.801, 14.302, 5)]

  it('fills a missing arrival when the track ends on the ground at an aerodrome', () => {
    expect(missingLogAerodromes({ departureIcao: 'ESMI', arrivalIcao: '' }, round, AD, 20)).toEqual({ arrivalIcao: 'ESMI' })
  })

  it('fills a missing departure from the takeoff point', () => {
    expect(missingLogAerodromes({ departureIcao: '', arrivalIcao: 'ESMI' }, round, AD, 20)).toEqual({ departureIcao: 'ESMI' })
  })

  it('keeps what is already set', () => {
    expect(missingLogAerodromes({ departureIcao: 'ESMX', arrivalIcao: 'ESMX' }, round, AD, 20)).toEqual({})
  })

  it('leaves the arrival blank when the track ends in the air (recording gap)', () => {
    const airborne = [at(56.8, 14.3, 60), at(56.801, 14.302, 90)]
    expect(missingLogAerodromes({ departureIcao: 'ESMI', arrivalIcao: '' }, airborne, AD, 20)).toEqual({})
  })

  it('leaves the arrival blank for a landing away from any aerodrome', () => {
    const field = [at(56.8, 14.3, 60), at(57.3, 15.0, 0)]
    expect(missingLogAerodromes({ departureIcao: 'ESMI', arrivalIcao: '' }, field, AD, 20)).toEqual({})
  })

  it('does nothing without a track or aerodrome data', () => {
    expect(missingLogAerodromes({}, [], AD, 20)).toEqual({})
    expect(missingLogAerodromes({}, round, [], 20)).toEqual({})
  })
})

describe('normalizeLogPlace', () => {
  it('upper-cases an aerodrome code', () => {
    expect(normalizeLogPlace(' esmi ')).toBe('ESMI')
  })
  it('keeps a typed name as written, spaces collapsed', () => {
    expect(normalizeLogPlace('  Farm   strip Ljungby ')).toBe('Farm strip Ljungby')
  })
  it('caps the length', () => {
    expect(normalizeLogPlace('x'.repeat(100))).toHaveLength(30)
  })
  it('blank stays blank', () => {
    expect(normalizeLogPlace('   ')).toBe('')
  })
})

describe('logEndAerodromes', () => {
  it('suggests the aerodromes at both ends, also when still moving', () => {
    const t = [at(56.8, 14.3, 60), at(56.93, 14.731, 40)]
    expect(logEndAerodromes(t, AD)).toEqual({ departure: 'ESMI', arrival: 'ESMX' })
  })
})
