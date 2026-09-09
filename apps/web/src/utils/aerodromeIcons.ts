/**
 * src/utils/aerodromeIcons.ts
 *
 * Aerodrome symbols — hand-written geometric SVGs in public/poi_icons/
 * (matching ICAO/VFR chart conventions exactly), recoloured and rasterised
 * via svgIconLoader. Same math as the original canvas-drawn versions, just
 * expressed as static SVG so both web and native can share the same source
 * asset.
 *
 * Registered image IDs (use in 'icon-image' expressions):
 *   ad-airport    Blue circle with white runway crosshair  — AD / AH types
 *   ad-heliport   Purple circle with white "H"             — HP type
 *
 * Call registerAerodromeImages(map) inside a styledata event handler.
 */

import type * as maplibregl from 'maplibre-gl'
import { registerColoredSvgIcon } from './svgIconLoader'

const SZ2 = 56 // 28 logical px × 2 for HiDPI

const ICONS: [string, string, string][] = [
  ['ad-airport',  '/poi_icons/ad-airport.svg',  '#1a56db'],
  ['ad-heliport', '/poi_icons/ad-heliport.svg', '#9333ea'],
]

/**
 * Fetches, recolours, and registers all aerodrome icons with the MapLibre map.
 * Safe to call multiple times — skips IDs that are already registered.
 */
export function registerAerodromeImages(map: maplibregl.Map): void {
  for (const [id, url, color] of ICONS) {
    registerColoredSvgIcon(map, id, url, color, SZ2).catch(() => { /* non-fatal */ })
  }
}
