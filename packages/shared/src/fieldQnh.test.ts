import { describe, it, expect } from 'vitest'
import { fieldQnhCandidate } from './fieldQnh'

// Station pressure at 500 ft for a true QNH of 1020 hPa.
const elevFt = 500
const pressureHpa = 1020 * Math.pow(1 - (elevFt / 3.28084) / 44301.59796, 1 / 0.190295)

describe('fieldQnhCandidate', () => {
  it('recovers QNH when parked at the field', () => {
    const q = fieldQnhCandidate({ pressureHpa, elevationFt: elevFt, distanceNm: 0.2, speedKts: 0 })
    expect(q).toBeCloseTo(1020, 1)
  })
  it('rejects when too far from the aerodrome', () => {
    expect(fieldQnhCandidate({ pressureHpa, elevationFt: elevFt, distanceNm: 3, speedKts: 0 })).toBeNull()
  })
  it('rejects when moving', () => {
    expect(fieldQnhCandidate({ pressureHpa, elevationFt: elevFt, distanceNm: 0.1, speedKts: 40 })).toBeNull()
  })
  it('rejects implausible results (wrong elevation / bad reading)', () => {
    expect(fieldQnhCandidate({ pressureHpa: 700, elevationFt: 0, distanceNm: 0.1, speedKts: 0 })).toBeNull()
  })
})
