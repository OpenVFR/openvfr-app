import { describe, it, expect } from 'vitest'
import { computeTrajectoryTicks, computeTrajectoryEndTick, computeVspeedTrajectory, trajectoryPitchDeg } from './virtualRadarCalc'

const ticks = [{ distNm: 2, timeMin: 1 }, { distNm: 6, timeMin: 3 }, { distNm: 10, timeMin: 5 }]
const noMsa = () => 0

describe('computeTrajectoryTicks', () => {
  it('draws from 1 kt, not 5', () => {
    expect(computeTrajectoryTicks({ currentDistNm: 0, currentSpeedKts: 2, timeMode: true, marks: [1], totalNm: 50 })).toHaveLength(1)
    expect(computeTrajectoryTicks({ currentDistNm: 0, currentSpeedKts: 0.5, timeMode: true, marks: [1], totalNm: 50 })).toHaveLength(0)
  })
})

describe('computeVspeedTrajectory', () => {
  it('extrapolates a known vertical speed', () => {
    const r = computeVspeedTrajectory({ currentDistNm: 0, currentAltFt: 3000, currentVSpeedFpm: 500, ticks, getMsa: noMsa })
    expect(r.estimated).toBe(false)
    expect(r.attitude).toBe('climb')
    expect(r.points.map((p) => p.altFt)).toEqual([3000, 3500, 4500, 5500])
  })
  it('draws a level, estimated line when the vertical speed is unknown', () => {
    for (const vs of [undefined, null]) {
      const r = computeVspeedTrajectory({ currentDistNm: 0, currentAltFt: 3000, currentVSpeedFpm: vs, ticks, getMsa: noMsa })
      expect(r.estimated).toBe(true)
      expect(r.attitude).toBe('level')
      expect(r.points.map((p) => p.altFt)).toEqual([3000, 3000, 3000, 3000])
    }
  })
  it('flags points below MSA', () => {
    const r = computeVspeedTrajectory({ currentDistNm: 0, currentAltFt: 2000, currentVSpeedFpm: -500, ticks, getMsa: () => 1500 })
    expect(r.points.map((p) => p.below)).toEqual([false, false, true, true])
  })
})

describe('computeTrajectoryEndTick', () => {
  const base = { currentSpeedKts: 60, timeMode: true, marks: [1, 3, 5] }   // 1, 3, 5 NM ahead at 60 kt
  it('extends the line to the route end when the far marks fall beyond it', () => {
    const e = computeTrajectoryEndTick({ ...base, currentDistNm: 8, totalNm: 10 })!
    expect(e.distNm).toBe(10)
    expect(e.timeMin).toBeCloseTo(2)
  })
  it('is null when every mark is on the route, or the aircraft is past the end', () => {
    expect(computeTrajectoryEndTick({ ...base, currentDistNm: 0, totalNm: 50 })).toBeNull()
    expect(computeTrajectoryEndTick({ ...base, currentDistNm: 12, totalNm: 10 })).toBeNull()
  })
  it('is null when the last kept mark already sits on the end', () => {
    expect(computeTrajectoryEndTick({ ...base, currentDistNm: 7, totalNm: 10 })).toBeNull()   // 3 NM mark lands on 10
  })
})

describe('trajectoryPitchDeg', () => {
  it('tilts with the drawn slope, clamped, and is level when estimated', () => {
    expect(trajectoryPitchDeg({ x: 0, y: 100 }, { x: 100, y: 0 }, false)).toBeCloseTo(30)       // 45° clamps to 30
    expect(trajectoryPitchDeg({ x: 0, y: 0 }, { x: 100, y: 10 }, false)).toBeCloseTo(-5.71, 1)  // descending
    expect(trajectoryPitchDeg({ x: 0, y: 100 }, { x: 100, y: 0 }, true)).toBe(0)
    expect(trajectoryPitchDeg(undefined, { x: 1, y: 1 }, false)).toBe(0)
  })
})
