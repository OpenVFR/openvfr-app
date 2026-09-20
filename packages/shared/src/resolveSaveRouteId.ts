/**
 * resolveSaveRouteId — pure decision logic for which row a route save
 * should target. Shared between web (useRouteDb.ts) and native
 * (RouteLibrarySheet.tsx) so the id-vs-name-matching rule — and the
 * Save/Save As split it backs — behaves identically on both platforms.
 *
 * Returns:
 *   - `routeId` verbatim when given (the "Save" path — update this exact
 *     row regardless of name; see each platform's Route Library Save/Save
 *     As split).
 *   - the id of an existing route whose `name` matches exactly (excluding
 *     `excludeId`, normally the 'current' working-route row) when no
 *     `routeId` is given (the "Save As"/untitled path's overwrite-by-name
 *     fallback).
 *   - `null` when neither applies — caller should generate a fresh id.
 */
export function resolveSaveRouteId(
  routeId: string | undefined,
  name: string,
  existingRoutes: { id: string; name: string }[],
  excludeId: string,
): string | null {
  if (routeId) return routeId
  const match = existingRoutes.find(r => r.id !== excludeId && r.name === name)
  return match?.id ?? null
}
