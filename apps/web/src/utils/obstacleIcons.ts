/**
 * src/utils/obstacleIcons.ts
 *
 * Obstacle icons — sourced from Temaki (CC0) and Maki (CC0) SVGs in
 * public/poi_icons/, recoloured and rasterised via svgIconLoader.
 *
 * Registered image IDs (reference these in 'icon-image' expressions):
 *   obs-wind-turbine   Temaki wind_turbine.svg     (amber)
 *   obs-tower          Temaki tower.svg            (red)
 *   obs-chimney        Temaki chimney.svg          (dark red)
 *   obs-building       Maki building.svg           (grey)
 *   obs-water-tower    Temaki water_tower.svg      (teal) — shares source
 *                      with lmk-water-tower (landmarks), matching symbol
 *                      instead of the generic building box
 *   obs-other          Maki triangle-stroked.svg   (orange)
 *
 * Colours sourced from @open-vfr/shared/featureColors OBSTACLE_COLORS —
 * never hardcode a copy here (see AGENTS.md colour-palette gotcha).
 *
 * Call registerObstacleImages(map) inside a styledata event handler.
 */

import type * as maplibregl from 'maplibre-gl'
import { registerColoredSvgIcon } from './svgIconLoader'
import { OBSTACLE_COLORS } from '@open-vfr/shared/featureColors'

const SZ2 = 56 // 28 logical px × 2 for HiDPI

const ICONS: [string, string, string][] = [
  ['obs-wind-turbine', '/poi_icons/obs-wind-turbine.svg',   OBSTACLE_COLORS.windTurbine],
  ['obs-tower',        '/poi_icons/obs-tower.svg',          OBSTACLE_COLORS.tower],
  ['obs-chimney',      '/poi_icons/obs-chimney.svg',        OBSTACLE_COLORS.chimney],
  ['obs-building',     '/poi_icons/obs-building.svg',       OBSTACLE_COLORS.building],
  ['obs-water-tower',  '/poi_icons/lmk-water-tower.svg',    OBSTACLE_COLORS.waterTower],
  ['obs-other',        '/poi_icons/obs-other.svg',          OBSTACLE_COLORS.default],
]

/**
 * Fetches, recolours, and registers all obstacle icons with the MapLibre map.
 * Safe to call multiple times — skips IDs that are already registered.
 * Call inside a `map.once('styledata', ...)` or `map.on('styledata', ...)` handler.
 */
export function registerObstacleImages(map: maplibregl.Map): void {
  for (const [id, url, color] of ICONS) {
    registerColoredSvgIcon(map, id, url, color, SZ2).catch(() => { /* non-fatal */ })
  }
}

/**
 * Same {url, color} pairs as ICONS above, keyed by the raw obstacle `kind`
 * string (see @open-vfr/shared/virtualRadarCalc's ObstacleMark.kind) instead
 * of the map's registered image id — lets VirtualRadar.tsx render the exact
 * same pictograms in the vertical-profile chart without a second, drifting
 * copy of these URL/colour pairs. `water_tower` isn't currently present in
 * the live obstacle data (see obstacleIcons.ts header) but is included here
 * for the same forward-compat reason it's registered above.
 */
export const OBSTACLE_ICON_DEFS: Record<string, { url: string; color: string }> = {
  wind_turbine: { url: '/poi_icons/obs-wind-turbine.svg', color: OBSTACLE_COLORS.windTurbine },
  tower:        { url: '/poi_icons/obs-tower.svg',        color: OBSTACLE_COLORS.tower },
  chimney:      { url: '/poi_icons/obs-chimney.svg',      color: OBSTACLE_COLORS.chimney },
  building:     { url: '/poi_icons/obs-building.svg',     color: OBSTACLE_COLORS.building },
  water_tower:  { url: '/poi_icons/lmk-water-tower.svg',  color: OBSTACLE_COLORS.waterTower },
}
export const OBSTACLE_ICON_FALLBACK_DEF = { url: '/poi_icons/obs-other.svg', color: OBSTACLE_COLORS.default }
