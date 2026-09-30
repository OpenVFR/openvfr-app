import { describe, it, expect } from 'vitest'
import { unionRectLoops, airspaceOutlines } from './airspaceOutline'

describe('unionRectLoops', () => {
  it('returns one rectangle loop for a single rect', () => {
    const loops = unionRectLoops([{ x1: 0, x2: 10, y1: 1500, y2: 6500 }])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
  })

  it('merges a 2500 ft sector nested inside a 1500 ft sector into one outline', () => {
    // 1500 floor over 0-30, 2500 floor over 5-20 (fully inside): the 2500 line must vanish
    const loops = unionRectLoops([
      { x1: 0, x2: 30, y1: 1500, y2: 6500 },
      { x1: 5, x2: 20, y1: 2500, y2: 6500 },
    ])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
  })

  it('draws a stepped floor where floors differ side by side', () => {
    // 2500 floor 0-10, 1500 floor 10-20, 2500 floor 20-30 -> one loop, floor steps down then up
    const loops = unionRectLoops([
      { x1: 0, x2: 10, y1: 2500, y2: 6500 },
      { x1: 10, x2: 20, y1: 1500, y2: 6500 },
      { x1: 20, x2: 30, y1: 2500, y2: 6500 },
    ])
    expect(loops).toHaveLength(1)
    const ys = new Set(loops[0].map(([, y]) => y))
    expect(ys).toEqual(new Set([1500, 2500, 6500]))
    expect(loops[0]).toHaveLength(8)
  })

  it('keeps disjoint rectangles as separate loops', () => {
    expect(unionRectLoops([
      { x1: 0, x2: 5, y1: 0, y2: 1000 },
      { x1: 10, x2: 15, y1: 0, y2: 1000 },
    ])).toHaveLength(2)
  })
})

describe('airspaceOutlines', () => {
  const tma = { fill: 'f1', border: 'b1' }
  const ctr = { fill: 'f2', border: 'b2' }
  it('groups by style and does not merge different styles', () => {
    const out = airspaceOutlines([
      { ...tma, lower_ft: 1500, upper_ft: 6500, entryNm: 0, exitNm: 30 },
      { ...tma, lower_ft: 2500, upper_ft: 6500, entryNm: 5, exitNm: 20 },
      { ...ctr, lower_ft: 0, upper_ft: 2000, entryNm: 5, exitNm: 18 },
    ])
    expect(out).toHaveLength(2)
    expect(out.find((s) => s.fill === 'f1')!.loops).toHaveLength(1)
  })
  it('clamps the top to the chart maximum and drops bands entirely above it', () => {
    const out = airspaceOutlines([
      { ...tma, lower_ft: 1500, upper_ft: 66000, entryNm: 0, exitNm: 10 },
      { ...tma, lower_ft: 9500, upper_ft: 66000, entryNm: 0, exitNm: 10 },
    ], 6000)
    expect(out).toHaveLength(1)
    const ys = out[0].loops[0].map(([, y]) => y)
    expect(Math.max(...ys)).toBe(6000)
  })
})

import { visibleEdges } from './airspaceOutline'

describe('visibleEdges', () => {
  const has = (segs: number[][], s: number[]) => segs.some((x) => x.every((v, i) => v === s[i]))

  it('hides the higher floor (not the side edges) of a sector nested in a lower one', () => {
    const segs = visibleEdges([
      { x1: 0, x2: 30, y1: 1500, y2: 6500 },
      { x1: 5, x2: 20, y1: 2500, y2: 6500 },
    ])
    expect(has(segs, [5, 2500, 20, 2500])).toBe(false)   // 2500 floor inside the 1500 sector
    expect(has(segs, [5, 1500, 5, 6500])).toBe(false)
    expect(has(segs, [5, 2500, 5, 6500])).toBe(true)     // side edge stays
    expect(has(segs, [0, 1500, 30, 1500])).toBe(true)    // outer floor stays
  })

  it('keeps the line between two sectors that only touch', () => {
    const segs = visibleEdges([
      { x1: 0, x2: 10, y1: 2500, y2: 6500 },
      { x1: 10, x2: 20, y1: 1500, y2: 6500 },
    ])
    // shared boundary (2500-6500) plus the step down (1500-2500), joined into one line
    expect(has(segs, [10, 1500, 10, 6500])).toBe(true)
  })

  it('draws a stepped floor when one sector overlaps a higher-floored one', () => {
    // C: floor 2500 over 0-30. A: floor 1500 over 5-20. A's floor and the part of its
    // sides below 2500 show; C's floor inside A is hidden.
    const segs = visibleEdges([
      { x1: 0, x2: 30, y1: 2500, y2: 6500 },
      { x1: 5, x2: 20, y1: 1500, y2: 6500 },
    ])
    expect(has(segs, [5, 1500, 20, 1500])).toBe(true)
    expect(has(segs, [5, 1500, 5, 6500])).toBe(true)     // side edge stays, also inside C
    expect(has(segs, [5, 2500, 20, 2500])).toBe(false)   // C's floor inside A
    expect(has(segs, [0, 2500, 5, 2500])).toBe(true)     // C's floor outside A
    expect(has(segs, [20, 2500, 30, 2500])).toBe(true)
  })
})
