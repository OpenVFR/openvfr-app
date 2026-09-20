import { describe, it, expect } from 'vitest'
import { isRouteDirty, type RouteSnapshot } from './routeDirty'

const wp = (lat: number, lng: number) => ({ lat, lng })

describe('isRouteDirty', () => {
  it('is not dirty when unlinked and empty', () => {
    const current: RouteSnapshot = { waypoints: [], legOverrides: [], aircraftId: '' }
    expect(isRouteDirty(current, undefined)).toBe(false)
  })

  it('is dirty when unlinked but has waypoints (untitled work in progress)', () => {
    const current: RouteSnapshot = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: '' }
    expect(isRouteDirty(current, undefined)).toBe(true)
  })

  it('is not dirty when identical to the linked snapshot', () => {
    const snap: RouteSnapshot = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: 'ac1' }
    expect(isRouteDirty({ ...snap, waypoints: [...snap.waypoints], legOverrides: [...snap.legOverrides] }, snap)).toBe(false)
  })

  it('is dirty when waypoints differ from the linked snapshot', () => {
    const linked: RouteSnapshot  = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: 'ac1' }
    const current: RouteSnapshot = { waypoints: [wp(1, 1), wp(3, 3)], legOverrides: [{}], aircraftId: 'ac1' }
    expect(isRouteDirty(current, linked)).toBe(true)
  })

  it('is dirty when leg overrides differ from the linked snapshot', () => {
    const linked: RouteSnapshot  = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: 'ac1' }
    const current: RouteSnapshot = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{ altFt: 3000 }], aircraftId: 'ac1' }
    expect(isRouteDirty(current, linked)).toBe(true)
  })

  it('is dirty when aircraftId differs from the linked snapshot', () => {
    const linked: RouteSnapshot  = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: 'ac1' }
    const current: RouteSnapshot = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: 'ac2' }
    expect(isRouteDirty(current, linked)).toBe(true)
  })

  it('treats a linked route whose row no longer exists (deleted) as unlinked', () => {
    // Caller resolves the "not found" case to `undefined` before calling in —
    // any non-empty current route is then dirty, same as brand-new/untitled.
    const current: RouteSnapshot = { waypoints: [wp(1, 1), wp(2, 2)], legOverrides: [{}], aircraftId: 'ac1' }
    expect(isRouteDirty(current, undefined)).toBe(true)
  })
})
