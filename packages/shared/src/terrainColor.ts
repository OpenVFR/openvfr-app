/**
 * buildTerrainColorExpr — shared MapLibre `color-relief` expression builder,
 * used by both web (src/utils/terrainColor.ts re-exports this) and native
 * (AviationMap.tsx's `terrain-color` layer). Single source of truth per
 * AGENTS.md's "never hardcode a copy of a shared colour palette" rule.
 *
 * Returns a MapLibre color-relief expression for the given reference altitude.
 * Elevation from ['elevation'] is in metres. Colour bands:
 *   transparent -> sea/below-safe  |  green -> > 1500 ft clearance
 *   yellow -> 1000-1500 ft below ref  |  orange -> 500-1000 ft below
 *   red -> < 500 ft below ref (or above ref)
 *
 * NOTE: color-relief-color is a ColorRampProperty -- it REQUIRES an
 * 'interpolate' expression. A 'step' expression is silently ignored (falls
 * back to transparent). Return type is a plain array (not
 * maplibre-gl's ExpressionSpecification) so this has no web-only import --
 * callers cast to whatever expression type their MapLibre binding expects.
 */
export function buildTerrainColorExpr(refAltFt: number): unknown[] {
  const refM = refAltFt * 0.3048
  // Compute thresholds (metres MSL) for each colour band.
  const t1 = Math.max(1,        refM - 457.2)  // green  start (> 1500 ft clearance)
  const t2 = Math.max(t1 + 1,   refM - 304.8)  // yellow start (1000-1500 ft)
  const t3 = Math.max(t2 + 1,   refM - 152.4)  // orange start (500-1000 ft)
  const t4 = Math.max(t3 + 1,   refM)          // red    start (< 500 ft / above ref)
  // Bottom anchor: always at 0 m (sea level) -> transparent.
  // min(t1-0.1, 0) ensures the anchor is at or below sea level so stops are
  // strictly ascending even when t1=1 (minimum clamped value).
  const t0 = Math.min(t1 - 0.1, 0)
  return [
    'interpolate', ['linear'], ['elevation'],
    t0, 'rgba(0,0,0,0)',             // transparent -- well below ref
    t1, 'rgba(74,222,128,0.4)',      // green       -- > 1500 ft clearance
    t2, 'rgba(250,204,21,0.45)',     // yellow      -- 1000-1500 ft clearance
    t3, 'rgba(251,146,60,0.5)',      // orange      -- 500-1000 ft clearance
    t4, 'rgba(239,68,68,0.55)',      // red         -- < 500 ft / above ref
  ]
}
