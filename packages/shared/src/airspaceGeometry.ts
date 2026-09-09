/**
 * Airspace geometry helpers — point-in-polygon (ray casting) for GeoJSON.
 *
 * Used by useAirspaceWarnings on both web and native.
 * No dependencies — pure math.
 */

/** Ray-casting point-in-polygon for a single GeoJSON ring. */
export function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** Point-in-polygon for GeoJSON Polygon (outer ring + holes) or MultiPolygon. */
export function pointInPolygon(
  lat: number,
  lng: number,
  geometry: { type: 'Polygon'; coordinates: number[][][] }
           | { type: 'MultiPolygon'; coordinates: number[][][][] },
): boolean {
  if (geometry.type === 'Polygon') {
    const [outer, ...holes] = geometry.coordinates
    if (!pointInRing(lat, lng, outer)) return false
    for (const hole of holes) {
      if (pointInRing(lat, lng, hole)) return false
    }
    return true
  }
  for (const poly of geometry.coordinates) {
    const [outer, ...holes] = poly
    if (!pointInRing(lat, lng, outer)) continue
    let inHole = false
    for (const hole of holes) {
      if (pointInRing(lat, lng, hole)) { inHole = true; break }
    }
    if (!inHole) return true
  }
  return false
}
