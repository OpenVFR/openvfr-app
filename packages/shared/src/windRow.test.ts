import { describe, it, expect } from 'vitest'
import { layoutWindRow, type WindRowItem } from './windRow'

const base = { tickPx: [0, 200, 400, 600], minPx: 12, maxPx: 588, leftLimitPx: 4, rightLimitPx: 600 }
const item = (key: string, px: number, priority = 0, labelW = 43): WindRowItem => ({ key, px, priority, labelW })

describe('layoutWindRow', () => {
  it('draws barb + text at the true position when it is clear', () => {
    expect(layoutWindRow([item('a', 100)], base)).toEqual([{ key: 'a', px: 100, label: 'right' }])
  })
  it('never moves a barb', () => {
    for (const px of [30, 150, 190, 210, 399, 560]) {
      const r = layoutWindRow([item('a', px)], base)
      if (r.length) expect(r[0].px).toBe(px)
    }
  })
  it('drops the text first: text would touch a tick label, bare barb still fits', () => {
    // right text spans 163..215 and hits the tick at 200; bare barb 154..172 is clear;
    // left text 102..163 is clear -> flips left rather than shrinking
    expect(layoutWindRow([item('a', 154)], base)[0].label).toBe('left')
    // both text sides blocked, bare barb clear
    const t = { ...base, tickPx: [0, 100, 200, 300] }
    expect(layoutWindRow([item('a', 150)], t)[0].label).toBeNull()
  })
  it('omits the barb when even the bare barb overlaps a tick label', () => {
    expect(layoutWindRow([item('a', 205)], base)).toEqual([])
  })
  it('omits a barb that overlaps an already placed one; higher priority wins', () => {
    const r = layoutWindRow([item('gr', 105, 1), item('st', 100, 0)], base)
    expect(r.map((x) => x.key)).toEqual(['st'])
  })
  it('flips the text left near the right edge', () => {
    expect(layoutWindRow([item('a', 560)], base)[0].label).toBe('left')
  })
  it('omits barbs outside the allowed range', () => {
    expect(layoutWindRow([item('a', 5)], base)).toEqual([])
  })
})

import { nudgeOffTicks } from './windAloft'
describe('nudgeOffTicks', () => {
  it('moves a sample sitting on a tick and leaves free ones', () => {
    const out = nudgeOffTicks([10, 30], 36.2, 36.2 / 6)
    expect(out[0]).toBe(10)
    const step = 36.2 / 6
    const r = out[1] % step
    expect(Math.min(r, step - r)).toBeGreaterThanOrEqual(step / 3 - 0.06)
  })
})
