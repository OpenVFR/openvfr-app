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
