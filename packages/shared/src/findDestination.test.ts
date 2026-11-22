import { describe, it, expect } from 'vitest'
import { isRouteEnd } from './findDestination'

describe('isRouteEnd', () => {
  const route = [{ lat: 59, lng: 18 }, { lat: 59.5, lng: 18.5 }]
  it('true only for the last waypoint', () => {
    expect(isRouteEnd(route, 59.5, 18.5)).toBe(true)
    expect(isRouteEnd(route, 59.5001, 18.5001)).toBe(true)
    expect(isRouteEnd(route, 59, 18)).toBe(false)
    expect(isRouteEnd([], 59, 18)).toBe(false)
    expect(isRouteEnd(undefined, 59, 18)).toBe(false)
  })
})
