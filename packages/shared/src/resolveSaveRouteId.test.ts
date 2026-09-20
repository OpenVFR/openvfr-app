import { describe, it, expect } from 'vitest'
import { resolveSaveRouteId } from './resolveSaveRouteId'

const routes = [
  { id: 'route-a', name: 'Sunday club run' },
  { id: 'route-b', name: 'EGYE – EGXC' },
]

describe('resolveSaveRouteId', () => {
  it('uses the given routeId verbatim (Save path), ignoring name entirely', () => {
    // Even if the name doesn't match anything, or matches a *different* row —
    // an explicit routeId always wins. This is what lets "Save" update the
    // linked row in place after a rename, and what makes "Save As" force a
    // brand-new row by passing a freshly generated uuid as routeId.
    expect(resolveSaveRouteId('route-a', 'EGYE – EGXC', routes, 'current')).toBe('route-a')
    expect(resolveSaveRouteId('brand-new-uuid', 'Sunday club run', routes, 'current')).toBe('brand-new-uuid')
  })

  it('matches an existing row by exact name when no routeId is given (untitled Save)', () => {
    expect(resolveSaveRouteId(undefined, 'Sunday club run', routes, 'current')).toBe('route-a')
  })

  it('returns null (caller generates a new id) when no routeId and no name match', () => {
    expect(resolveSaveRouteId(undefined, 'Brand New Route', routes, 'current')).toBeNull()
  })

  it('never matches the excluded id (the live "current" working-route row)', () => {
    const withCurrent = [...routes, { id: 'current', name: 'Sunday club run' }]
    expect(resolveSaveRouteId(undefined, 'Sunday club run', withCurrent, 'current')).toBe('route-a')
  })

  it('regression: repeated untitled Save with an unchanged name reuses the same row, never inserts duplicates', () => {
    // Mirrors the 2026-09-13 bug: 3 clicks of Save on the same name used to
    // create 3 separate rows because id was always freshly generated.
    let currentRoutes = [...routes]
    const targetId = resolveSaveRouteId(undefined, 'Sunday club run', currentRoutes, 'current')
    expect(targetId).toBe('route-a')
    // Simulate the upsert not changing the row set (same id reused) and
    // saving again — must still resolve to the same row, not a new one.
    currentRoutes = currentRoutes.map(r => r.id === 'route-a' ? { ...r, name: 'Sunday club run' } : r)
    expect(resolveSaveRouteId(undefined, 'Sunday club run', currentRoutes, 'current')).toBe('route-a')
  })
})
