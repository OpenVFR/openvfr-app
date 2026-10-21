import { describe, it, expect } from 'vitest'
import { placeLabels, type LabelRequest, type BoxRect } from './profileLabels'

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
