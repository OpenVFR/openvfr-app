import { describe, it, expect } from 'vitest'
import { trafficOnGround, trafficAltitudeM } from './trafficState'

describe('trafficOnGround', () => {
  it('trusts the ground flag while slow', () => {
    expect(trafficOnGround(true, 12)).toBe(true)
    expect(trafficOnGround(true, null)).toBe(true)
  })
  it('a slow flyer wrongly reported on ground is airborne', () => {
    expect(trafficOnGround(true, 55)).toBe(false)
  })
  it('never on ground without the flag', () => {
    expect(trafficOnGround(false, 0)).toBe(false)
  })
})

describe('trafficAltitudeM', () => {
  it('prefers GNSS altitude over pressure altitude', () => {
    expect(trafficAltitudeM(-107, 60)).toBe(60)
    expect(trafficAltitudeM(300, null)).toBe(300)
    expect(trafficAltitudeM(300, undefined)).toBe(300)
    expect(trafficAltitudeM(null, null)).toBe(null)
  })
})
