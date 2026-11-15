/**
 * The identifier of an aerodrome feature: its ICAO code, or for an aerodrome that has none (a private strip added from another
 * source, e.g. ESMARS) its `local_id`. '' when the feature is not an aerodrome. `runways` is only carried by the aerodromes source
 * (navaids, waypoints and obstacles never have it), so a `local_id` counts only together with it.
 */
export function aerodromeId(p: Record<string, unknown> | null | undefined): string {
  if (!p) return ''
  if (typeof p['icao'] === 'string' && p['icao']) return p['icao']
  if (typeof p['local_id'] === 'string' && p['local_id'] && (Array.isArray(p['runways']) || typeof p['runways'] === 'string')) return p['local_id']
  return ''
}
