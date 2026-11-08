import { describe, expect, it } from 'vitest'
import { occlusionBottomOver, type ReservedRegionLike } from './reservedRegions'

// iPhone Duo, outer display, portrait, horizontal bars (safearea.info, Xcode 27.1):
// camera 37x37 at (399.67, 29.33), status block 200x82 at (266, 0).
const COVER: ReservedRegionLike[] = [
  { kind: 'occlusion', frame: { x: 399.67, y: 29.33, width: 37, height: 37 } },
  { kind: 'occlusion', frame: { x: 266, y: 0, width: 200, height: 82 } },
]

describe('occlusionBottomOver', () => {
  it('clears the status block above a column at the right edge', () => {
    expect(occlusionBottomOver(COVER, 410, 458, 240)).toBe(82)
  })
  it('ignores occlusions beside the column', () => {
    expect(occlusionBottomOver(COVER, 8, 56, 240)).toBe(0)
  })
  it('follows a taller block (a Live Activity growing the island)', () => {
    const grown: ReservedRegionLike[] = [{ kind: 'occlusion', frame: { x: 266, y: 0, width: 200, height: 140 } }]
    expect(occlusionBottomOver(grown, 410, 458, 240)).toBe(140)
  })
  it('ignores occlusions below the top zone and divisions', () => {
    const rs: ReservedRegionLike[] = [
      { kind: 'occlusion', frame: { x: 400, y: 300, width: 40, height: 40 } },
      { kind: 'division', frame: { x: 330, y: 0, width: 10, height: 678 } },
    ]
    expect(occlusionBottomOver(rs, 410, 458, 240)).toBe(0)
  })
  it('is 0 with no regions (other phones, older iOS)', () => {
    expect(occlusionBottomOver([], 0, 400, 240)).toBe(0)
  })
})

import { statusBlockRegion } from './reservedRegions'

describe('statusBlockRegion', () => {
  it('finds the Duo status block (200x82 in the top-right corner)', () => {
    expect(statusBlockRegion(COVER, 82, 466)).toEqual({ x: 266, y: 0, width: 200, height: 82 })
  })
  it('ignores the camera cut-out (below the top edge, shorter than the inset)', () => {
    expect(statusBlockRegion([COVER[0]!], 82, 466)).toBeNull()
  })
  it('is null for a full-width region, no inset, or no regions', () => {
    const wide: ReservedRegionLike[] = [{ kind: 'occlusion', frame: { x: 0, y: 0, width: 466, height: 82 } }]
    expect(statusBlockRegion(wide, 82, 466)).toBeNull()
    expect(statusBlockRegion(COVER, 0, 466)).toBeNull()
    expect(statusBlockRegion([], 82, 466)).toBeNull()
  })
})
