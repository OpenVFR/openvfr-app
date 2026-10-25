import { describe, it, expect } from 'vitest'
import {
  profileChartLayout, profileYMax, declutterMarks, obstacleOpacity, isLimitingObstacle, altitudeTicks, formatAltitudeTick, formatAltitudeFt, distanceTicks,
  polylinePath, groundAreaPath, belowMsaRuns, nearestSampleIndex, clampProfileZoom, scrollAfterZoom, MAX_PROFILE_PX_PER_NM, profileYMin, altitudeTicksFrom, waterBandTopFt,
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

describe('declutterMarks', () => {
  it('keeps the highest priority in a crowd and spaces the rest', () => {
    const kept = declutterMarks([
      { id: 'a', x: 100, priority: 1 },
      { id: 'b', x: 104, priority: 5 },   // wins over a
      { id: 'c', x: 140, priority: 1 },
      { id: 'd', x: 143, priority: 1 },   // too close to c, loses (left to right)
    ], 10)
    expect([...kept].sort()).toEqual(['b', 'c'])
  })
  it('keeps everything that is far enough apart', () => {
    expect(declutterMarks([{ id: 'a', x: 0, priority: 0 }, { id: 'b', x: 50, priority: 0 }], 20).size).toBe(2)
  })
})

describe('obstacleOpacity', () => {
  it('is full near the line and fades to 65 % at the abeam limit', () => {
    expect(obstacleOpacity(0.4, 5)).toBe(1)
    expect(obstacleOpacity(1, 5)).toBe(1)
    expect(obstacleOpacity(5, 5)).toBeCloseTo(0.65)
    expect(obstacleOpacity(3, 5)).toBeCloseTo(0.825)
    expect(obstacleOpacity(2, 1)).toBe(1)
  })
})

describe('isLimitingObstacle', () => {
  it('is true when tip + clearance rounds up to the MSA', () => {
    expect(isLimitingObstacle(2650, 500, 3200)).toBe(true)   // 3150 -> 3200
    expect(isLimitingObstacle(2650, 500, 3300)).toBe(false)
    expect(isLimitingObstacle(0, 500, 3000)).toBe(false)
    expect(isLimitingObstacle(2650, 500, 0)).toBe(false)
  })
})

describe('profile zoom', () => {
  const base = { viewportW: 440, height: 200, margin, totalNm: 100, yMax: 5000, minPxPerNm: 1 }
  it('zoom 1 is the unchanged layout; zoom widens the plot', () => {
    const a = profileChartLayout(base), b = profileChartLayout({ ...base, zoom: 3 })
    expect(a.plotW).toBe(390)
    expect(b.plotW).toBe(1170)
    expect(b.scrollable).toBe(true)
  })
  it('clamps below 1 and above the max px/NM', () => {
    expect(clampProfileZoom(0.2, 390, 100)).toBe(1)
    expect(clampProfileZoom(1e6, 390, 100)).toBeCloseTo((MAX_PROFILE_PX_PER_NM * 100) / 390)
    expect(clampProfileZoom(NaN, 390, 100)).toBe(1)
  })
  it('keeps the anchored route position under the same viewport x', () => {
    const sl = scrollAfterZoom({ scrollLeft: 100, anchorPx: 200, plotLeft: 40, oldPlotW: 800, newPlotW: 1600, viewportW: 440, newContentW: 1650 })
    const nmBefore = (100 + 200 - 40) / 800, nmAfter = (sl + 200 - 40) / 1600
    expect(nmAfter).toBeCloseTo(nmBefore)
  })
  it('never scrolls outside the content', () => {
    expect(scrollAfterZoom({ scrollLeft: 0, anchorPx: 0, plotLeft: 40, oldPlotW: 800, newPlotW: 400, viewportW: 440, newContentW: 450 })).toBeGreaterThanOrEqual(0)
    expect(scrollAfterZoom({ scrollLeft: 5000, anchorPx: 400, plotLeft: 40, oldPlotW: 800, newPlotW: 800, viewportW: 440, newContentW: 850 })).toBe(410)
  })
})

import { liveAltitudeWindow } from './profileChart'
describe('liveAltitudeWindow', () => {
  it('level flight low down: window from the ground, aircraft near the top', () => {
    expect(liveAltitudeWindow(1500, 0)).toEqual({ yMin: 0, yMax: 3500 })
  })
  it('level flight high: window grows with altitude and follows it up', () => {
    const w = liveAltitudeWindow(5000, 0)
    expect(w.yMin).toBeLessThanOrEqual(1500)
    expect(w.yMax).toBeGreaterThanOrEqual(6000)
  })
  it('a climb leaves room above, a descent room below', () => {
    const climb = liveAltitudeWindow(3000, 700), desc = liveAltitudeWindow(3000, -700)
    expect(climb.yMax - 3000).toBeGreaterThan(desc.yMax - 3000)
    expect(3000 - desc.yMin).toBeGreaterThan(3000 - climb.yMin)
  })
  it('never goes below ground and keeps at least 2000 ft of span', () => {
    const w = liveAltitudeWindow(100, -1500)
    expect(w.yMin).toBe(0)
    expect(w.yMax - w.yMin).toBeGreaterThanOrEqual(2000)
  })
})

describe('profileYMin / altitudeTicksFrom', () => {
  it('is 0 without ground data or near the coast', () => {
    expect(profileYMin([], [], 5000)).toBe(0)
    expect(profileYMin([20, 100], [1500], 5000)).toBe(0)
  })
  it('lifts the floor over high ground, 500 ft below the lowest ground or plan', () => {
    expect(profileYMin([2300, 2600], [3500], 8000)).toBe(1500)
    expect(profileYMin([2300, 2600], [2000], 8000)).toBe(1500)
  })
  it('keeps at least 2000 ft of scale', () => {
    expect(profileYMin([4800], [], 5000)).toBe(3000)
  })
  it('starts the ticks at the floor', () => {
    expect(altitudeTicksFrom(5000, 0)).toEqual(altitudeTicks(5000))
    const t = altitudeTicksFrom(5000, 1500)
    expect(t[0]).toBe(1500)
    expect(t.slice(1).every((v) => v > 1500)).toBe(true)
  })
})

describe('waterBandTopFt', () => {
  it('is at least 200 ft and follows terrain samples over the water', () => {
    expect(waterBandTopFt([], 0, 4000)).toBe(200)
    expect(waterBandTopFt([10, 15], 0, 4000)).toBe(200)
    expect(waterBandTopFt([480, 450], 0, 4000)).toBe(480)
  })
  it('is capped at the scale top', () => {
    expect(waterBandTopFt([5200], 0, 4000)).toBe(4000)
  })
  it('is null when the water is not above the scale floor (live altitude window in flight)', () => {
    // Climbing through 3 200 ft: the window starts at 2 500 ft, the lake is at sea level.
    expect(waterBandTopFt([0, 3], 2500, 6000)).toBeNull()
    expect(waterBandTopFt([0], 200, 4000)).toBeNull()
    expect(waterBandTopFt([0], 0, 4000)).toBe(200)
  })
})
