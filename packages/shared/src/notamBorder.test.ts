import { describe, it, expect } from 'vitest'
import { prepareBorderRings, followOutline } from './notamBorder'

// A is on the outline, M bends away from the straight chord A-B, B on the outline.
const A = [12.25, 57.3], M = [12.4, 57.2], B = [12.3333, 57.0833]
const country = [[[A, M, B, [12.0, 56.0], [11.0, 56.0], [11.0, 58.0], A].map(p => [...p!])]]
const rings = prepareBorderRings({ XX: country })

describe('followOutline', () => {
  it('walks the shorter way and returns the vertices in between', () => {
    expect(followOutline(A, B, rings)).toEqual([M])
    expect(followOutline(B, A, rings)).toEqual([M])
  })
  it('snaps endpoints that lie near an edge, not on a vertex', () => {
    const near = [(A[0]! + M[0]!) / 2 + 0.005, (A[1]! + M[1]!) / 2] // ~0.15 NM off the edge A-M
    expect(followOutline(near, B, rings)).toEqual([M])
  })
  it('refuses when an endpoint is farther than the snap distance', () => {
    expect(followOutline([A[0]! + 0.2, A[1]!], B, rings)).toBeNull()
  })
  it('refuses when both ways round are within a factor of 2', () => {
    const square = prepareBorderRings({ XX: [[[[0, 50], [1, 50], [1, 51], [0, 51], [0, 50]]]] })
    expect(followOutline([0, 50], [1, 51], square)).toBeNull() // opposite corners
    expect(followOutline([0, 50], [0.5, 50], square)).not.toBeNull() // short side vs three sides
  })
  it('chooses the ring that carries both endpoints', () => {
    const other = [[[[20, 40], [21, 40], [21, 41], [20, 41], [20, 40]]]]
    const r = prepareBorderRings({ YY: other, XX: country })
    expect(followOutline(A, B, r)).toEqual([M])
  })
})
