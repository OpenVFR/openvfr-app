/**
 * notamCoverageArea.ts — geometric primitives for deciding whether a
 * NOTAM's own geometry (circle, point, or real Polygon/MultiPolygon) falls
 * within a country's tracked coverage area.
 *
 * Extracted from apps/api/src/notam.ts's cross-border inclusion path (see
 * that file's own header for the full design rationale: NMS-API's account-
 * wide FIR/ICAO allow-list misses NOTAMs filed under a neighboring
 * country's FIR whose actual geographic area still reaches into tracked
 * airspace — a real German military exercise NOTAM, icaoLocation=EDWW,
 * Q-line center 54.30N/12.1833E radius 85nm, 60nm from Sweden's own bbox
 * edge, was the motivating live example). Promoted into packages/shared
 * per CONTRIBUTING.md's flight-critical test-coverage rule ("Airspace
 * intersection / containment logic") — apps/api has no test runner
 * configured, packages/shared already does (vitest), so the pure-geometry
 * primitives live here where they can actually be tested, and apps/api
 * imports them rather than duplicating.
 *
 * Deliberately conservative throughout: a false negative (skip a
 * genuinely-relevant NOTAM) just means it's missing until the next
 * judgment call; a false positive (include an unrelated one) pollutes the
 * regional NOTAM list/map with noise. Circles get an exact geometric
 * intersection test against their own real radius (more precise than a
 * generic buffer, and it's what actually catches the EDWW example above
 * with zero slop); polygons/points fall back to a generic margin since
 * there's no radius to work from.
 */

export interface CoverageBbox {
  south: number
  west:  number
  north: number
  east:  number
}

export type NotamPolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

function nmPerDegLon(atLatDeg: number): number {
  return 60 * Math.cos((atLatDeg * Math.PI) / 180)
}

/**
 * Closest point on the (unbuffered) bbox rectangle to (lat, lon), converted
 * to nm offsets, then straight-line distance -- a rough closest-point-on-
 * rectangle check, not a great-circle-accurate geometric intersection.
 * Good enough at this scale: this decides "cache this NOTAM at all", not
 * "render a precise boundary".
 */
export function circleIntersectsBbox(
  lat: number, lon: number, radiusNm: number, bbox: CoverageBbox,
): boolean {
  const clampedLat = Math.min(Math.max(lat, bbox.south), bbox.north)
  const clampedLon = Math.min(Math.max(lon, bbox.west), bbox.east)
  const dLatNm = (lat - clampedLat) * 60
  const dLonNm = (lon - clampedLon) * nmPerDegLon(lat)
  const distNm = Math.hypot(dLatNm, dLonNm)
  return distNm <= radiusNm
}

export function pointNearBbox(
  lat: number, lon: number, marginDeg: number, bbox: CoverageBbox,
): boolean {
  return lat >= bbox.south - marginDeg && lat <= bbox.north + marginDeg &&
         lon >= bbox.west  - marginDeg && lon <= bbox.east  + marginDeg
}

export function polygonNearBbox(
  polygon: NotamPolygonGeometry, marginDeg: number, bbox: CoverageBbox,
): boolean {
  const rings = polygon.type === 'Polygon' ? polygon.coordinates : polygon.coordinates.flat()
  for (const ring of rings) {
    for (const vertex of ring) {
      const lon = vertex[0]
      const lat = vertex[1]
      if (lon === undefined || lat === undefined) continue
      if (pointNearBbox(lat, lon, marginDeg, bbox)) return true
    }
  }
  return false
}
