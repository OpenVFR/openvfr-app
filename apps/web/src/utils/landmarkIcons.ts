/**
 * src/utils/landmarkIcons.ts
 *
 * OSM landmark icons — sourced from Temaki (CC0) and Maki (CC0) SVGs in
 * public/poi_icons/, recoloured and rasterised via svgIconLoader.
 *
 * Registered image IDs:
 *   lmk-church      Maki place-of-worship.svg   (slate)
 *   lmk-mast        Temaki mast.svg             (orange)
 *   lmk-windmill    Temaki windmill.svg         (brown)
 *   lmk-water-tower Temaki water_tower.svg      (teal)
 *   lmk-chimney     Temaki chimney.svg          (rust — shares source with obs-chimney, different tint)
 *
 * Call registerLandmarkImages(map) inside a styledata event handler.
 */

import type * as maplibregl from 'maplibre-gl'
import { registerColoredSvgIcon } from './svgIconLoader'

type MapLike = Pick<maplibregl.Map, 'addImage' | 'hasImage' | 'removeImage'>

const SZ2 = 56 // 28 logical px × 2 for HiDPI

const ICONS: [string, string, string][] = [
  ['lmk-church',      '/poi_icons/lmk-church.svg',      '#455a64'],
  ['lmk-mast',        '/poi_icons/lmk-mast.svg',        '#e65100'],
  ['lmk-windmill',    '/poi_icons/lmk-windmill.svg',    '#5d4037'],
  ['lmk-water-tower', '/poi_icons/lmk-water-tower.svg', '#00695c'],
  ['lmk-chimney',     '/poi_icons/lmk-chimney.svg',     '#bf360c'],
]

/**
 * Fetches, recolours, and registers all landmark icons with the MapLibre map.
 * Safe to call multiple times — skips IDs that are already registered.
 */
export function registerLandmarkImages(map: MapLike): void {
  for (const [id, url, color] of ICONS) {
    registerColoredSvgIcon(map as maplibregl.Map, id, url, color, SZ2).catch(() => { /* non-fatal */ })
  }
}
