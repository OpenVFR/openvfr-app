/**
 * Ray-casting point-in-polygon test for GeoJSON rings.
 * Returns true if [lng, lat] is inside the exterior ring.
 */
export function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Returns true if [lng, lat] is inside any ring of a Polygon or MultiPolygon
 * coordinate array (tests only exterior rings — sufficient for airspace tap).
 */
export function pointInPolygonCoords(
  lng: number,
  lat: number,
  coords: number[][],
): boolean {
  return pointInRing(lng, lat, coords)
}
