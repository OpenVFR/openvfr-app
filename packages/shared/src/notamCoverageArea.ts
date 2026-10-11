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

// ── Country outlines (real borders incl. islands) ───────────────────────────
// A rectangle per country is far too coarse for "does this NOTAM reach the
// country": Sweden's spans the whole Baltic and the coasts of Finland,
// Estonia, Latvia and Lithuania. These test against the country's actual
// land outline (MultiPolygon, [lon, lat] rings, holes ignored) plus a
// buffer in NM -- e.g. 12 NM, the territorial sea, i.e. the country's own
// airspace.

/** MultiPolygon coordinates: polygons -> rings -> [lon, lat] points. */
export type CountryOutline = number[][][][]

/** Precomputed outline + its bbox, for a cheap reject before the exact test. */
export interface PreparedOutline {
  rings: number[][][]   // outer rings only
  bbox: CoverageBbox
}

export function prepareOutline(outline: CountryOutline): PreparedOutline {
  const rings = outline.map(p => p[0]).filter((r): r is number[][] => !!r && r.length >= 3)
  let south = 90, west = 180, north = -90, east = -180
  for (const r of rings) for (const [lon, lat] of r) {
    if (lat! < south) south = lat!; if (lat! > north) north = lat!
    if (lon! < west) west = lon!;   if (lon! > east) east = lon!
  }
  return { rings, bbox: { south, west, north, east } }
}

function inRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number]
    const [xj, yj] = ring[j] as [number, number]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Local flat projection in NM around refLat -- fine at the scale of a
// NOTAM buffer (tens of NM), same approach as circleIntersectsBbox.
function segDistNm(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Distance (NM) from a point to the outline; 0 when on land inside it. */
export function distanceToOutlineNm(lat: number, lon: number, o: PreparedOutline): number {
  const kx = nmPerDegLon(lat), ky = 60
  let best = Infinity
  for (const ring of o.rings) {
    if (inRing(lat, lon, ring)) return 0
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1] as [number, number]
      const [bx, by] = ring[i] as [number, number]
      const d = segDistNm(lon * kx, lat * ky, ax * kx, ay * ky, bx * kx, by * ky)
      if (d < best) best = d
    }
  }
  return best
}

function bboxGrow(b: CoverageBbox, nm: number): CoverageBbox {
  const dLat = nm / 60
  const dLon = nm / Math.max(1, nmPerDegLon(Math.max(Math.abs(b.south), Math.abs(b.north))))
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLon, east: b.east + dLon }
}

/** Point within bufferNm of the outline (or on land). */
export function pointNearOutline(lat: number, lon: number, bufferNm: number, o: PreparedOutline): boolean {
  if (!pointNearBbox(lat, lon, 0, bboxGrow(o.bbox, bufferNm))) return false
  return distanceToOutlineNm(lat, lon, o) <= bufferNm
}

/** Circle (radius NM) reaching within bufferNm of the outline. */
export function circleNearOutline(lat: number, lon: number, radiusNm: number, bufferNm: number, o: PreparedOutline): boolean {
  if (!circleIntersectsBbox(lat, lon, radiusNm, bboxGrow(o.bbox, bufferNm))) return false
  return distanceToOutlineNm(lat, lon, o) <= radiusNm + bufferNm
}

function segsIntersect(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) =>
    Math.sign((q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!))
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)
}

/**
 * NOTAM polygon reaching within bufferNm of the outline: a vertex near it,
 * an edge crossing it, or the country lying inside the NOTAM area.
 */
export function polygonNearOutline(polygon: NotamPolygonGeometry, bufferNm: number, o: PreparedOutline): boolean {
  const rings = polygon.type === 'Polygon' ? [polygon.coordinates[0]] : polygon.coordinates.map(p => p[0])
  const grown = bboxGrow(o.bbox, bufferNm)
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue
    // Cheap reject: NOTAM area's own bbox doesn't touch the grown outline bbox.
    let s = 90, w = 180, n = -90, e = -180
    for (const [lon, lat] of ring) {
      if (lat! < s) s = lat!; if (lat! > n) n = lat!
      if (lon! < w) w = lon!; if (lon! > e) e = lon!
    }
    if (n < grown.south || s > grown.north || e < grown.west || w > grown.east) continue
    for (const v of ring) {
      const [lon, lat] = v as [number, number]
      if (pointNearOutline(lat, lon, bufferNm, o)) return true
    }
    for (const cr of o.rings) {
      const first = cr[0]
      if (first && inRing(first[1]!, first[0]!, ring)) return true
      for (let i = 1; i < ring.length; i++) {
        for (let j = 1; j < cr.length; j++) {
          if (segsIntersect(ring[i - 1]!, ring[i]!, cr[j - 1]!, cr[j]!)) return true
        }
      }
    }
  }
  return false
}
