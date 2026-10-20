import { describe, it, expect } from 'vitest'
import {
  profileChartLayout, profileYMax, altitudeTicks, formatAltitudeTick, formatAltitudeFt, distanceTicks,
  polylinePath, groundAreaPath, belowMsaRuns, nearestSampleIndex,
} from './profileChart'

const margin = { top: 10, right: 10, bottom: 30, left: 40 }

describe('profileChartLayout', () => {
  it('fits a short route into the viewport', () => {
    const l = profileChartLayout({ viewportW: 450, height: 200, margin, totalNm: 10, yMax: 5000, minPxPerNm: 30 })
    expect(l.plotW).toBe(400)
    expect(l.plotH).toBe(160)
    expect(l.contentW).toBe(450)
    expect(l.scrollable).toBe(false)
    expect(l.xOf(0)).toBe(40)
    expect(l.xOf(10)).toBe(440)
    expect(l.yOf(0)).toBe(170)
    expect(l.yOf(5000)).toBe(10)
    expect(l.nmAtX(240)).toBe(5)
    expect(l.nmAtX(-100)).toBe(0)
    expect(l.nmAtX(9999)).toBe(10)
  })
  it('grows past the viewport for a long route', () => {
    const l = profileChartLayout({ viewportW: 450, height: 200, margin, totalNm: 100, yMax: 5000, minPxPerNm: 30 })
    expect(l.plotW).toBe(3000)
    expect(l.contentW).toBe(3050)
    expect(l.scrollable).toBe(true)
  })
  it('survives a zero-length route', () => {
    const l = profileChartLayout({ viewportW: 450, height: 200, margin, totalNm: 0, yMax: 5000, minPxPerNm: 30 })
    expect(l.xOf(3)).toBe(40)
    expect(l.nmAtX(100)).toBe(0)
  })
})

describe('profileYMax', () => {
  it('leaves 25 % (at least 1000 ft) above the planned altitude, rounded up', () => {
    expect(profileYMax(3500, [])).toBe(5000)   // +1000 ft wins
    expect(profileYMax(4500, [])).toBe(6000)   // 5625 -> 6000
    expect(profileYMax(12000, [])).toBe(15000) // +25 % wins
  })
  it('clears high terrain and never goes below 3000', () => {
    expect(profileYMax(1500, [{ elevFt: 4000 }])).toBe(5000)
    expect(profileYMax(0, [])).toBe(3000)
  })
})

describe('altitudeTicks', () => {
  it('uses round steps', () => {
    expect(altitudeTicks(6000)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000])
    expect(altitudeTicks(3000)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000])
    expect(altitudeTicks(12000)).toEqual([0, 2000, 4000, 6000, 8000, 10000, 12000])
  })
  it('never steps below 500 ft', () => {
    expect(altitudeTicks(1000)).toEqual([0, 500, 1000])
  })
})

describe('formatAltitudeTick / formatAltitudeFt', () => {
  it('labels the QNH altitude scale in feet, never as flight levels', () => {
    expect(formatAltitudeTick(0)).toBe('0 ft')
    expect(formatAltitudeTick(500)).toBe('500')
    expect(formatAltitudeTick(1000)).toBe('1000')
    expect(formatAltitudeTick(4500)).toBe('4500')
    expect(formatAltitudeTick(12000)).toBe('12000')
  })
  it('formats readouts with the unit', () => {
    expect(formatAltitudeFt(3499.6)).toBe('3500 ft')
    expect(formatAltitudeFt(156)).toBe('156 ft')
  })
})

describe('distanceTicks', () => {
  it('lands on round numbers and leaves the unit-label strip free', () => {
    expect(distanceTicks(36)).toEqual([0, 5, 10, 15, 20, 25, 30])
    expect(distanceTicks(100)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90])
    expect(distanceTicks(100, 4)).toEqual([0, 20, 40, 60, 80])
  })
  it('never steps below 1', () => {
    expect(distanceTicks(3)).toEqual([0, 1, 2])
  })
  it('handles an empty axis', () => {
    expect(distanceTicks(0)).toEqual([0])
  })
})

describe('paths', () => {
  const xOf = (nm: number) => nm * 10
  const yOf = (ft: number) => 100 - ft / 10
  it('builds a polyline', () => {
    expect(polylinePath([{ distNm: 0, altFt: 0 }, { distNm: 1, altFt: 500 }], xOf, yOf)).toBe('M0.0,100.0 L10.0,50.0')
    expect(polylinePath([{ distNm: 0, altFt: 0 }], xOf, yOf)).toBe('')
  })
  it('closes the ground area to 0 ft', () => {
    expect(groundAreaPath([{ distNm: 0, elevFt: 100 }, { distNm: 2, elevFt: 300 }], xOf, yOf, 2))
      .toBe('M0.0,100.0 L0.0,90.0 L20.0,70.0 L20.0,100.0 Z')
  })
})

describe('belowMsaRuns', () => {
  const distNms = [0, 5, 10, 15, 20, 25, 30, 35, 40]
  it('returns each below-MSA stretch with its safe neighbours', () => {
    const plannedAlts = [3000, 3000, 3000, 1000, 1000, 3000, 3000, 3000, 3000]
    const runs = belowMsaRuns({ distNms, plannedAlts, getMsa: () => 2000, totalNm: 40 })
    expect(runs).toEqual([[
      { distNm: 10, altFt: 3000 }, { distNm: 15, altFt: 1000 }, { distNm: 20, altFt: 1000 }, { distNm: 25, altFt: 3000 },
    ]])
  })
  it('ignores the climb-out and approach near the endpoints', () => {
    const plannedAlts = [0, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 0]
    expect(belowMsaRuns({ distNms, plannedAlts, getMsa: () => 2000, totalNm: 40 })).toEqual([])
  })
})

describe('nearestSampleIndex', () => {
  it('finds the closest sample', () => {
    expect(nearestSampleIndex([0, 1, 2, 3], 1.4)).toBe(1)
    expect(nearestSampleIndex([0, 1, 2, 3], 1.6)).toBe(2)
    expect(nearestSampleIndex([0, 1, 2, 3], -5)).toBe(0)
    expect(nearestSampleIndex([0, 1, 2, 3], 50)).toBe(3)
    expect(nearestSampleIndex([], 1)).toBe(-1)
  })
})
