import { describe, it, expect } from 'vitest'
import { pickWaypointLabels, estimateLabelWidth } from './profileLabels'

const rect = (left: number, w: number) => ({ left, right: left + w })

describe('estimateLabelWidth', () => {
  it('scales with the name and caps', () => {
    expect(estimateLabelWidth('WP7')).toBe(18)
    expect(estimateLabelWidth('Helgeandskyrkan')).toBe(60)
    expect(estimateLabelWidth('Helgeandskyrkan', Infinity)).toBe(80)
  })
})

describe('pickWaypointLabels', () => {
  it('skips the departure and keeps clear labels', () => {
    expect(pickWaypointLabels([rect(0, 20), rect(100, 30), rect(200, 30)], 0)).toEqual([1, 2])
  })
  it('drops a middle label that overlaps the previous kept one', () => {
    expect(pickWaypointLabels([rect(0, 20), rect(100, 50), rect(120, 30), rect(300, 30)], 0)).toEqual([1, 3])
  })
  it('drops a label that starts inside the left boundary', () => {
    expect(pickWaypointLabels([rect(0, 20), rect(10, 30), rect(200, 30)], 40)).toEqual([2])
  })
  it('lets the destination evict earlier labels it would cover', () => {
    // The destination label is pushed left (clamped) onto the previous one.
    expect(pickWaypointLabels([rect(0, 20), rect(100, 52), rect(150, 22), rect(130, 22)], 0)).toEqual([3])
  })
  it('keeps earlier labels the destination does not touch', () => {
    expect(pickWaypointLabels([rect(0, 20), rect(60, 30), rect(150, 40), rect(160, 22)], 0)).toEqual([1, 3])
  })
  it('handles a two-point route', () => {
    expect(pickWaypointLabels([rect(0, 20), rect(100, 30)], 0)).toEqual([1])
    expect(pickWaypointLabels([rect(0, 20)], 0)).toEqual([])
  })
})
