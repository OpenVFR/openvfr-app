/**
 * makeCirclePolygon — builds a GeoJSON Polygon approximating a circle of
 * `radiusNm` nautical miles centered at `lat`/`lng`.
 *
 * Shared between web (glide-range ring, NOTAM circles) and native (NOTAM
 * circles) -- originally written inline in apps/web/src/components/
 * MapView.tsx for the glide-range ring; promoted here once native needed
 * the identical math for its own NOTAM circle layer, rather than
 * duplicating it a second time.
 */

import type { Feature, Polygon } from 'geojson'

export function makeCirclePolygon(
  lat: number,
  lng: number,
  radiusNm: number,
  steps = 72,
): Feature<Polygon> {
  const R = 3440.065 // Earth radius NM
  const d = radiusNm / R
  const coords: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI
    const lat1    = lat * Math.PI / 180
    const lng1    = lng * Math.PI / 180
    const lat2    = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing))
    const lng2    = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
    coords.push([lng2 * 180 / Math.PI, lat2 * 180 / Math.PI])
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} }
}
