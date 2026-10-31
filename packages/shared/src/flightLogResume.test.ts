import { describe, it, expect } from 'vitest'
import { canResumeLog, resumableUntil } from './flightLogResume'

const MIN = 60_000
const LANDED = 20
const PARK = 5 * MIN
// ~0.01 deg lat = 0.6 NM
const parked = { lat: 56.8, lng: 14.3, spdKts: 3, ts: 1_000_000 }
const flying = { lat: 56.8, lng: 14.3, spdKts: 95, ts: 1_000_000 }

describe('resumableUntil', () => {
  it('parked: the split timeout; per leg: never', () => {
    expect(resumableUntil(parked, LANDED, PARK)).toBe(parked.ts + PARK)
    expect(resumableUntil(parked, LANDED, 0)).toBe(0)
  })
  it('flying: 10 minutes, whatever the split timeout', () => {
    expect(resumableUntil(flying, LANDED, 0)).toBe(flying.ts + 10 * MIN)
  })
})

describe('canResumeLog', () => {
  it('continues a parked log with a takeoff from the same place within the timeout', () => {
    expect(canResumeLog(parked, { lat: 56.805, lng: 14.3, ts: parked.ts + 3 * MIN }, LANDED, PARK)).toBe(true)
  })
  it('not after the timeout', () => {
    expect(canResumeLog(parked, { lat: 56.8, lng: 14.3, ts: parked.ts + 6 * MIN }, LANDED, PARK)).toBe(false)
  })
  it('not from another aerodrome', () => {
    expect(canResumeLog(parked, { lat: 56.9, lng: 14.3, ts: parked.ts + MIN }, LANDED, PARK)).toBe(false)
  })
  it('in the air: allows the distance flown in between', () => {
    // 4 min later, 0.2 deg (12 NM) away: within 2 + 3*4 = 14 NM.
    expect(canResumeLog(flying, { lat: 57.0, lng: 14.3, ts: flying.ts + 4 * MIN }, LANDED, PARK)).toBe(true)
    // 1 min later the same distance is too far.
    expect(canResumeLog(flying, { lat: 57.0, lng: 14.3, ts: flying.ts + MIN }, LANDED, PARK)).toBe(false)
  })
  it('in the air: not after 10 minutes', () => {
    expect(canResumeLog(flying, { lat: 56.8, lng: 14.3, ts: flying.ts + 11 * MIN }, LANDED, PARK)).toBe(false)
  })
  it('never backwards in time', () => {
    expect(canResumeLog(parked, { lat: 56.8, lng: 14.3, ts: parked.ts - 1 }, LANDED, PARK)).toBe(false)
  })
})
