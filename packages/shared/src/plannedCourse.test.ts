import { describe, it, expect } from 'vitest'
import { onPlannedCourse } from './plannedCourse'

// Leg due north, 10 NM, from (60,17).
const route = [{ lat: 60, lng: 17 }, { lat: 60 + 10 / 60, lng: 17 }]
const own = (o: Partial<{ lat: number; lng: number; trackDeg: number; speedKts: number }>) =>
  ({ lat: 60.05, lng: 17, trackDeg: 0, speedKts: 90, ...o })

describe('onPlannedCourse', () => {
  it('is true on the leg, heading along it', () => expect(onPlannedCourse(own({}), route)).toBe(true))
  it('is false when too far off the leg', () => expect(onPlannedCourse(own({ lng: 17.05 }), route)).toBe(false))
  it('is false when heading away from the leg bearing', () => expect(onPlannedCourse(own({ trackDeg: 90 }), route)).toBe(false))
  it('is false when flying the leg backwards', () => expect(onPlannedCourse(own({ trackDeg: 180 }), route)).toBe(false))
  it('is false past the end of the leg', () => expect(onPlannedCourse(own({ lat: 60.3 }), route)).toBe(false))
  it('is false when stationary or without a route', () => {
    expect(onPlannedCourse(own({ speedKts: 0 }), route)).toBe(false)
    expect(onPlannedCourse(own({}), [])).toBe(false)
  })
})
