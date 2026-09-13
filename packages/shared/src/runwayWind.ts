/**
 * runwayWind — decomposes a surface wind (METAR) into per-runway-end
 * headwind/tailwind and crosswind components, so AerodromePopup can
 * highlight which runway end is currently favoured and colour-code the
 * crosswind severity per end.
 *
 * Deliberately separate from windRelative.ts: that module is track-relative
 * (aircraft heading in flight), this one is runway-heading-relative (static
 * ground reference, no aircraft state). They share the crosswind severity
 * classifier/thresholds (imported, not duplicated) so the colour a pilot
 * sees on the ground and in the air means the same thing.
 *
 * Convention:
 *   headwindKt > 0 → headwind at that end (favourable for takeoff/landing)
 *   headwindKt < 0 → tailwind at that end
 *   crosswindKt     → magnitude only (≥ 0); side doesn't change the limit check
 */

import { classifyCrosswindSeverity, type CrosswindSeverity } from './windRelative'
import type { ParsedWind } from './fetchWx'

export interface RunwayThresholdInput {
  designator: string
  mag_brg: number | null
}

export interface RunwayWindEnd {
  designator: string
  magBrgDeg: number | null
  /** Null when wind or this end's bearing is unknown. */
  headwindKt: number | null
  crosswindKt: number | null
  crosswindSeverity: CrosswindSeverity | null
  /** True on the end(s) with the highest headwind component for this runway. */
  favored: boolean
}

/**
 * Computes per-end wind components for one runway's thresholds (normally 2,
 * e.g. "09" and "27"). Returns nulled-out entries (no favoured end) when
 * wind is calm/variable/unknown, so callers can render the runway plainly
 * rather than special-casing "no wind" themselves.
 */
export function computeRunwayWind(
  thresholds: RunwayThresholdInput[],
  wind: ParsedWind | null,
): RunwayWindEnd[] {
  if (!wind || wind.calm || wind.dirDeg == null) {
    return thresholds.map((t) => ({
      designator: t.designator,
      magBrgDeg: t.mag_brg,
      headwindKt: null,
      crosswindKt: null,
      crosswindSeverity: null,
      favored: false,
    }))
  }

  const ends: RunwayWindEnd[] = thresholds.map((t) => {
    if (t.mag_brg == null) {
      return {
        designator: t.designator,
        magBrgDeg: null,
        headwindKt: null,
        crosswindKt: null,
        crosswindSeverity: null,
        favored: false,
      }
    }
    const diffRad = (wind.dirDeg! - t.mag_brg) * Math.PI / 180
    const headwindKt = Math.round(wind.speedKt * Math.cos(diffRad))
    const crosswindKt = Math.round(Math.abs(wind.speedKt * Math.sin(diffRad)))
    return {
      designator: t.designator,
      magBrgDeg: t.mag_brg,
      headwindKt,
      crosswindKt,
      crosswindSeverity: classifyCrosswindSeverity(crosswindKt),
      favored: false,
    }
  })

  const withWind = ends.filter((e) => e.headwindKt != null)
  if (withWind.length > 0) {
    const bestHw = Math.max(...withWind.map((e) => e.headwindKt!))
    for (const e of ends) {
      if (e.headwindKt === bestHw) e.favored = true
    }
  }
  return ends
}

// ── Map-level highlight (favored runway end pops on the map itself) ────────
// Shared between web (map-style.ts's 'runway-threshold-label' layer, applied
// imperatively via map.setPaintProperty) and native (AviationMap.tsx's same
// layer, applied declaratively via its paint prop) so both platforms agree
// on exactly what "favored" looks like -- one definition, not two drifting
// copies. Returns plain arrays/values (not maplibre-gl's ExpressionSpecification
// type, same convention as terrainColor.ts's buildTerrainColorExpr) so this
// file has no web-only import; each caller casts to whatever expression type
// its own MapLibre binding expects.

export const RUNWAY_LABEL_DEFAULT_SIZE: unknown[] =
  ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 14]
export const RUNWAY_LABEL_DEFAULT_OPACITY: unknown[] =
  ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 1]
export const RUNWAY_LABEL_DEFAULT_COLOR = '#ffffff'
export const RUNWAY_LABEL_DEFAULT_HALO = '#333840'
// Matches AerodromePopup's favored-end pill fill (see AerodromePopup.module.css
// .rwyDesigFavored / native AerodromePopup.tsx's runwayStyles.desigPill) --
// same visual language, map end and popup end, both platforms.
export const RUNWAY_FAVORED_COLOR = '#22c55e'
export const RUNWAY_FAVORED_HALO = '#0d3d1f'

export interface RunwayWindHighlightEnd {
  designator: string
  favored: boolean
}

export interface RunwayWindHighlightExpressions {
  color: unknown[] | string
  haloColor: unknown[] | string
  size: unknown[]
  opacity: unknown[]
}

/**
 * Builds paint-property expressions for the 'runway-threshold-label' layer
 * that make the wind-favored runway end pop on the map itself (not just in
 * AerodromePopup's detail panel) -- bigger, green text with a dark-green
 * halo; the OTHER end of that same runway is dimmed so the favored one
 * draws the eye. All other airports/runways on the map are unaffected.
 *
 * Pass an empty `ends` array (or `icao=''`) to get back the plain defaults --
 * used to clear a highlight when the aerodrome popup closes.
 */
export function buildRunwayWindHighlight(
  icao: string,
  ends: RunwayWindHighlightEnd[],
): RunwayWindHighlightExpressions {
  const favoredKeys = ends.filter((e) => e.favored).map((e) => `${icao}/${e.designator}`)
  const otherKeys   = ends.filter((e) => !e.favored).map((e) => `${icao}/${e.designator}`)
  const key: unknown[] = ['concat', ['get', 'icao'], '/', ['get', 'id']]

  if (favoredKeys.length === 0) {
    return {
      color: RUNWAY_LABEL_DEFAULT_COLOR,
      haloColor: RUNWAY_LABEL_DEFAULT_HALO,
      size: RUNWAY_LABEL_DEFAULT_SIZE,
      opacity: RUNWAY_LABEL_DEFAULT_OPACITY,
    }
  }

  return {
    color:     ['match', key, favoredKeys, RUNWAY_FAVORED_COLOR, RUNWAY_LABEL_DEFAULT_COLOR],
    haloColor: ['match', key, favoredKeys, RUNWAY_FAVORED_HALO,  RUNWAY_LABEL_DEFAULT_HALO],
    size:      ['match', key, favoredKeys, ['+', RUNWAY_LABEL_DEFAULT_SIZE, 3], RUNWAY_LABEL_DEFAULT_SIZE],
    opacity: otherKeys.length > 0
      ? ['*', RUNWAY_LABEL_DEFAULT_OPACITY, ['match', key, otherKeys, 0.4, 1]]
      : RUNWAY_LABEL_DEFAULT_OPACITY,
  }
}
