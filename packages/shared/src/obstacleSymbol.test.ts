import { describe, it, expect } from 'vitest'
import { obstacleSymbol, polyPath, MIN_FULL_HEIGHT_PX } from './obstacleSymbol'

describe('obstacleSymbol', () => {
  it('is null for obstacles too short to draw at full height', () => {
    expect(obstacleSymbol('building', 100, 92, 100)).toBeNull()                        // 8 px
    expect(obstacleSymbol('tower', 100, 100 - (MIN_FULL_HEIGHT_PX - 1), 100)).toBeNull()
  })
  it('draws a building as a rectangle from tip to ground', () => {
    const p = obstacleSymbol('building', 50, 20, 100)!
    const body = p.find((x) => x.t === 'rect')!
    expect(body.t).toBe('rect')
    if (body.t === 'rect') { expect(body.y).toBe(20); expect(body.h).toBe(80); expect(body.x + body.w / 2).toBeCloseTo(50) }
  })
  it('puts the highest blade of a turbine at the tip and the tower on the ground', () => {
    const p = obstacleSymbol('wind_turbine', 50, 20, 120)!
    const ys = p.flatMap((x) => x.t === 'line' ? [x.y1, x.y2] : x.t === 'poly' ? x.pts.map((q) => q[1]) : [])
    expect(Math.min(...ys)).toBeCloseTo(20)          // blade tip
    expect(Math.max(...ys)).toBeCloseTo(120)         // tower foot
  })
  it('stays inside its vertical extent for every kind', () => {
    for (const kind of ['building', 'chimney', 'wind_turbine', 'water_tower', 'tower', 'whatever']) {
      const p = obstacleSymbol(kind, 10, 30, 130)!
      const ys: number[] = []
      for (const x of p) {
        if (x.t === 'rect') ys.push(x.y, x.y + x.h)
        else if (x.t === 'line') ys.push(x.y1, x.y2)
        else if (x.t === 'poly') ys.push(...x.pts.map((q) => q[1]))
        else ys.push(x.cy - x.r, x.cy + x.r)
      }
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(30 - 0.01)
      expect(Math.max(...ys)).toBeLessThanOrEqual(130 + 0.01)
    }
  })
  it('polyPath closes the path', () => {
    expect(polyPath([[0, 0], [1, 2], [3, 4]])).toBe('M0.0,0.0 L1.0,2.0 L3.0,4.0 Z')
  })
})
