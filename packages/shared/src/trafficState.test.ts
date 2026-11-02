import { describe, it, expect } from 'vitest'
import { trafficOnGround, trafficAltitudeM, trafficDeviceLabel, trafficNetworkLabel } from './trafficState'

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

describe('traffic labels', () => {
  it('device from the address, network from the source', () => {
    expect(trafficDeviceLabel('ogn-dda5ba')).toBe('FLARM')
    // ADS-B relayed by an OGN station: still ADS-B, credited to OGN.
    expect(trafficDeviceLabel('4ab569')).toBe('ADS-B')
    expect(trafficNetworkLabel('ogn')).toBe('Open Glider Network')
    expect(trafficNetworkLabel('opensky')).toBe('OpenSky Network')
  })
})
