/**
 * suggestRouteName — default name offered when saving a route:
 * "<first waypoint> – <last waypoint>" (ICAO or waypoint name). Shared between
 * web (RouteLibrary.tsx) and native (RouteLibrarySheet.tsx).
 */

export function suggestRouteName(waypoints: ReadonlyArray<{ name?: string }>): string {
  if (waypoints.length === 0) return 'New Route'
  const dep = waypoints[0].name?.trim() || 'DEP'
  const dest = waypoints.length > 1 ? (waypoints[waypoints.length - 1].name?.trim() || 'DEST') : ''
  return dest ? `${dep} – ${dest}` : dep
}
