import { describe, it, expect } from 'vitest'
import { obstacleSymbol, polyPath, MIN_FULL_HEIGHT_PX, batchSymbolPaths, type SymbolPrim } from './obstacleSymbol'

describe('obstacleSymbol', () => {
  it('draws obstacles too short for a full shape at the minimum height, on the ground', () => {
    for (const kind of ['building', 'tower', 'wind_turbine']) {
      const p = obstacleSymbol(kind, 100, 98, 100)!
      const ys = p.flatMap((x) => x.t === 'line' ? [x.y1, x.y2] : x.t === 'poly' ? x.pts.map((q) => q[1]) : x.t === 'rect' ? [x.y, x.y + x.h] : [])
      expect(Math.max(...ys)).toBeCloseTo(100)
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(100 - MIN_FULL_HEIGHT_PX - 0.01)
    }
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

describe('batchSymbolPaths', () => {
  const rect = (x: number, fill = '#fff'): SymbolPrim => ({ t: 'rect', x, y: 0, w: 4, h: 20, fill })
  const shade = (x: number): SymbolPrim => ({ t: 'rect', x, y: 0, w: 1, h: 20, fill: 'rgba(0,0,0,0.3)' })

  it('merges the same layer and paint of many marks into one path', () => {
    const marks = Array.from({ length: 50 }, (_, i) => ({ cx: i * 10, scaleX: 1, shape: [rect(i * 10), shade(i * 10 + 3)] }))
    const paths = batchSymbolPaths(marks)
    expect(paths).toHaveLength(2)                       // layer 0 body, layer 1 shade
    expect(paths[0].d.split('Z').length - 1).toBe(50)   // 50 rects in one path
  })

  it('keeps a mark\'s own drawing order: layer 0 before layer 1', () => {
    const paths = batchSymbolPaths([{ cx: 0, scaleX: 1, shape: [rect(0), shade(3)] }])
    expect(paths.map((p) => p.fill)).toEqual(['#fff', 'rgba(0,0,0,0.3)'])
  })

  it('keeps different paints apart', () => {
    const paths = batchSymbolPaths([
      { cx: 0, scaleX: 1, shape: [rect(0, '#aaa')] },
      { cx: 10, scaleX: 1, shape: [rect(10, '#bbb')] },
      { cx: 20, scaleX: 1, opacity: 0.85, shape: [rect(20, '#aaa')] },
    ])
    expect(paths).toHaveLength(3)
  })

  it('widens a symbol around its centre', () => {
    const [p] = batchSymbolPaths([{ cx: 10, scaleX: 2, shape: [{ t: 'rect', x: 8, y: 0, w: 4, h: 10, fill: '#fff' }] }])
    expect(p.d).toBe('M6.0,0.0 L14.0,0.0 L14.0,10.0 L6.0,10.0 Z')
  })

  it('draws lines stroke-only and polygons and circles as closed paths', () => {
    const paths = batchSymbolPaths([{
      cx: 0, scaleX: 1,
      shape: [
        { t: 'line', x1: 0, y1: 0, x2: 5, y2: 5, stroke: '#000', w: 2 },
        { t: 'poly', pts: [[0, 0], [4, 0], [2, 3]], fill: '#f00' },
        { t: 'circle', cx: 0, cy: 0, r: 3, fill: '#0f0' },
      ],
    }])
    expect(paths[0]).toMatchObject({ line: true, fill: 'none', stroke: '#000', strokeWidth: 2, d: 'M0.0,0.0 L5.0,5.0' })
    expect(paths[1].d).toBe('M0.0,0.0 L4.0,0.0 L2.0,3.0 Z')
    expect(paths[2].d).toContain('A3.0,3.0')
  })

  it('flags an estimated symbol lighter and outlines it in its own colour', () => {
    const [p] = batchSymbolPaths([{ cx: 0, scaleX: 1, shape: [{ ...rect(0, '#abc'), dash: true }] }])
    expect(p.fillOpacity).toBe(0.7)
    expect(p.stroke).toBe('#abc')
  })

  it('skips marks without a shape', () => {
    expect(batchSymbolPaths([{ cx: 0, scaleX: 1, shape: null }, { cx: 1, scaleX: 1 }])).toEqual([])
  })
})
