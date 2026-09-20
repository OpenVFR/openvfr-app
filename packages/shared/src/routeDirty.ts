/**
 * routeDirty — pure comparison helper deciding whether the working route
 * has diverged from the saved route it's linked to (or, when unlinked,
 * whether it has any content at all worth prompting to save).
 *
 * Shared between web (RouteLibrary.tsx / useRouteDb.ts) and native
 * (RouteLibrarySheet.tsx / useRoute.ts) so the Save/Save As dirty-check is
 * identical on both platforms. Side-effect-free — see routeDirty.test.ts.
 */

import type { RouteWaypoint } from './routeCalc'
import type { LegOverride } from './types'

export interface RouteSnapshot {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  aircraftId:   string
}

/**
 * Returns true when `current` differs from `linked` (the last-saved state
 * of the route it's linked to), or when there's no linked route at all and
 * `current` has any waypoints (untitled work worth not losing silently).
 *
 * `linked` is `undefined` when the working route isn't linked to any saved
 * row, or when the previously-linked row no longer exists (e.g. deleted).
 */
export function isRouteDirty(current: RouteSnapshot, linked: RouteSnapshot | undefined): boolean {
  if (!linked) return current.waypoints.length > 0
  return JSON.stringify(current.waypoints)    !== JSON.stringify(linked.waypoints)
      || JSON.stringify(current.legOverrides) !== JSON.stringify(linked.legOverrides)
      || current.aircraftId                   !== linked.aircraftId
}
