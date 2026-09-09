/**
 * src/utils/navaidIcons.ts
 *
 * Navaid and VFR waypoint symbols — hand-written geometric SVGs in
 * public/poi_icons/ (matching ICAO/VFR chart conventions exactly), recoloured
 * and rasterised via svgIconLoader. Same math as the original canvas-drawn
 * versions, just expressed as static SVG so both web and native can share
 * the same source asset.
 *
 * Registered image IDs:
 *   nav-vor   Indigo hexagon compass-rose — VOR / DVOR / DVOR-DME
 *   nav-ndb   Orange double-circle        — NDB / HOMER
 *   wp-mrp    Teal filled triangle (\u2191)   — Mandatory Reporting Point
 *   wp-rp     Teal outline triangle (\u2191)  — VFR Reporting Point / ENR / ICAO
 *
 * Call registerNavaidImages(map) inside a styledata event handler.
 */

import type * as maplibregl from 'maplibre-gl'
import { registerColoredSvgIcon } from './svgIconLoader'

const SZ2 = 48 // 24 logical px × 2 for HiDPI

const ICONS: [string, string, string][] = [
  ['nav-vor', '/poi_icons/nav-vor.svg', '#5c4ae4'],
  ['nav-ndb', '/poi_icons/nav-ndb.svg', '#c05200'],
  ['wp-mrp',  '/poi_icons/wp-mrp.svg',  '#0ca678'],
  ['wp-rp',   '/poi_icons/wp-rp.svg',   '#20c997'],
]

/**
 * Fetches, recolours, and registers all navaid and waypoint icons with the
 * MapLibre map. Safe to call multiple times — skips IDs already registered.
 */
export function registerNavaidImages(map: maplibregl.Map): void {
  for (const [id, url, color] of ICONS) {
    registerColoredSvgIcon(map, id, url, color, SZ2).catch(() => { /* non-fatal */ })
  }
}
