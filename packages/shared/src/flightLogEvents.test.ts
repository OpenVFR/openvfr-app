import { describe, it, expect } from 'vitest'
import { flightLogEvents } from './flightLogEvents'

// East-bound at 60° N, 1 point/s at ~90 kt: taxi, fly 6 min at 2000 ft, land.
const spd = [...Array(10).fill(10), ...Array(360).fill(90), ...Array(20).fill(5)]
const track = spd.map((v, i) => ({ lat: 60, lng: 15 + i * 0.0008, altFt: v > 50 ? 2000 : 100, spdKts: v, ts: i * 1000 }))
const square = (lng0: number, lng1: number, cls: string, name: string) => ({
  type: 'Feature' as const,
  properties: { class: cls, type: cls === 'MODEL' ? 'MODEL' : 'CTR', name, lower_ft: 0, upper_ft: 3000, lower_ref: 'GND', upper_ref: 'MSL' },
  geometry: { type: 'Polygon' as const, coordinates: [[[lng0, 59.9], [lng1, 59.9], [lng1, 60.1], [lng0, 60.1], [lng0, 59.9]]] },
})

describe('flightLogEvents', () => {
  it('lists takeoff, controlled-airspace entry and landing; model areas left out', () => {
    const airspace = { type: 'FeatureCollection' as const, features: [square(15.1, 15.15, 'D', 'TEST CTR'), square(15.2, 15.25, 'MODEL', 'MODEL FIELD')] }
    const ev = flightLogEvents(track, airspace, { takeoffKts: 30, landedKts: 20 })
    expect(ev.map((e) => e.kind)).toEqual(['takeoff', 'airspace', 'landing'])
    expect(ev[1].label).toContain('TEST CTR')
  })

  it('works without airspace data', () => {
    expect(flightLogEvents(track, null, { takeoffKts: 30, landedKts: 20 }).map((e) => e.kind)).toEqual(['takeoff', 'landing'])
  })
})
