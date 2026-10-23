import { describe, it, expect } from 'vitest'
import { placeLabels, mergeNearbyLabels, placeRadarLabels, type LabelRequest, type BoxRect } from './profileLabels'

const bounds: BoxRect = { left: 0, top: 0, right: 400, bottom: 200 }
const req = (id: string, x: number, o: Partial<LabelRequest> = {}): LabelRequest =>
  ({ id, x, top: 100, bottom: 110, halfW: 6, w: 60, h: 11, priority: 1, ...o })
const boxOf = (p: { left: number; baseline: number }, r: LabelRequest): BoxRect =>
  ({ left: p.left, top: p.baseline + 2 - r.h, right: p.left + r.w, bottom: p.baseline + 2 })
const hit = (a: BoxRect, b: BoxRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

describe('placeLabels', () => {
  it('puts a lone label above its symbol, centred', () => {
    const r = req('a', 200)
    const p = placeLabels([r], [], bounds).get('a')!
    expect(p.left).toBe(170)
    expect(boxOf(p, r).bottom).toBeLessThan(r.top)
  })
  it('never lets two labels overlap, moving or dropping the lower-priority one', () => {
    const rs = [req('hi', 200, { priority: 9 }), req('lo', 210, { priority: 1 }), req('lo2', 195, { priority: 1 })]
    const placed = placeLabels(rs, [], bounds)
    expect(placed.has('hi')).toBe(true)
    const boxes = [...placed.entries()].map(([id, p]) => boxOf(p, rs.find((r) => r.id === id)!))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i], boxes[j])).toBe(false)
  })
  it('keeps clear of avoid rectangles (other symbols)', () => {
    const r = req('a', 200)
    const wall: BoxRect = { left: 150, top: 70, right: 250, bottom: 99 }   // sits where "above centred" would go
    const p = placeLabels([r], [wall], bounds).get('a')!
    expect(hit(boxOf(p, r), wall)).toBe(false)
  })
  it('slides a label back inside the bounds at the edge', () => {
    const r = req('a', 5)
    const p = placeLabels([r], [], bounds).get('a')!
    expect(p.left).toBeGreaterThanOrEqual(0)
  })
  it('drops a label when nothing is free', () => {
    const r = req('a', 200)
    const everything: BoxRect = { left: -10, top: -10, right: 500, bottom: 300 }
    expect(placeLabels([r], [everything], bounds).has('a')).toBe(false)
  })
  it('the highest priority keeps the best spot', () => {
    const a = req('a', 200, { priority: 1 }), b = req('b', 200, { priority: 5 })
    const placed = placeLabels([a, b], [], bounds)
    expect(boxOf(placed.get('b')!, b).bottom).toBeLessThan(a.top)   // b above
    expect(placed.get('a')!.baseline).not.toBe(placed.get('b')!.baseline)
  })
})

describe('mergeNearbyLabels', () => {
  it('keeps the highest label of a crowd and counts the others', () => {
    const m = [
      { key: 'a', cx: 100, priority: 5, label: 'Turbine 300 ft' },
      { key: 'b', cx: 140, priority: 9, label: 'Turbine 400 ft' },
      { key: 'c', cx: 150, priority: 1, label: 'Turbine 200 ft' },
      { key: 'far', cx: 600, priority: 2, label: 'Mast 500 ft' },
    ]
    mergeNearbyLabels(m, 160)
    expect(m.map((x) => x.label)).toEqual(['', 'Turbine 400 ft +2', '', 'Mast 500 ft'])
  })
})

describe('placeRadarLabels', () => {
  const area: BoxRect = { left: 0, top: 0, right: 400, bottom: 200 }
  const wall: BoxRect[] = [{ left: 0, top: 80, right: 400, bottom: 130 }]
  it('lifts a must-show name with a leader when the symbol is walled in', () => {
    const r = req('obs-1', 200, { top: 100, bottom: 110 })
    const { placed, leaders } = placeRadarLabels({ requests: [r], symbols: wall, chips: [], clouds: [], area, mustShow: () => true })
    expect(placed.has('obs-1')).toBe(true)
    expect(leaders.has('obs-1')).toBe(true)
    expect(hit(boxOf(placed.get('obs-1')!, r), wall[0])).toBe(false)
  })
  it('drops clouds before the name disappears', () => {
    const r = req('obs-1', 200, { top: 100, bottom: 110 })
    const sym: BoxRect = { left: 194, top: 100, right: 206, bottom: 110 }
    const clouds: BoxRect[] = [{ left: 0, top: 60, right: 400, bottom: 99 }, { left: 0, top: 111, right: 400, bottom: 160 }]
    const withClouds = placeRadarLabels({ requests: [r], symbols: [sym], chips: [], clouds, area, mustShow: () => true })
    expect(withClouds.placed.has('obs-1')).toBe(true)
  })
  it('does not force names that need not show', () => {
    const r = req('poi-1', 200, { top: 100, bottom: 110 })
    const { placed } = placeRadarLabels({ requests: [r], symbols: [{ left: 0, top: 0, right: 400, bottom: 200 }], chips: [], clouds: [], area, mustShow: (id) => id.startsWith('obs-') })
    expect(placed.has('poi-1')).toBe(false)
  })
})
