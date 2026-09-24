import { describe, it, expect } from 'vitest'
import { circleIntersectsBbox, pointNearBbox, polygonNearBbox, type CoverageBbox, type NotamPolygonGeometry } from './notamCoverageArea'

// Sweden's own bbox (openvfr-infra's scripts/prepare-tiles.sh COUNTRY_BBOX,
// south/west/north/east) -- see apps/api/src/notam.ts's
// COUNTRY_COVERAGE_BBOX, duplicated there for the same reason as here.
const SWEDEN_BBOX: CoverageBbox = { south: 55.3, west: 10.9, north: 69.1, east: 24.2 }

describe('circleIntersectsBbox', () => {
  it('matches a real live example: EDWW M3011/26 (German NVG-training NOTAM)', () => {
    // Q)EDWW/QWELW/IV/BO/W/000/010/5418N01211E085 -- Q-line center
    // 54.30N/12.1833E, radius 85nm. Filed under EDWW (Bremen FIR), not
    // ESAA, but its circle reaches 60nm into Sweden's bbox at the same
    // longitude (55.3 - 54.3 = 1.0deg = 60nm), well inside its 85nm
    // radius -- this is the exact real-world case that motivated
    // apps/api/src/notam.ts's cross-border inclusion path.
    const lat = 54 + 18 / 60
    const lon = 12 + 11 / 60
    expect(circleIntersectsBbox(lat, lon, 85, SWEDEN_BBOX)).toBe(true)
  })

  it('rejects the same center with a too-small radius', () => {
    const lat = 54 + 18 / 60
    const lon = 12 + 11 / 60
    // Distance to bbox edge is ~60nm -- a 50nm radius falls short.
    expect(circleIntersectsBbox(lat, lon, 50, SWEDEN_BBOX)).toBe(false)
  })

  it('rejects a circle far from the bbox entirely (Spain)', () => {
    expect(circleIntersectsBbox(40.4, -3.7, 50, SWEDEN_BBOX)).toBe(false)
  })

  it('accepts a real point already inside the bbox with a small radius', () => {
    // Arlanda-area coordinates, well inside Sweden.
    expect(circleIntersectsBbox(59.651944, 17.918611, 5, SWEDEN_BBOX)).toBe(true)
  })

  it('accepts a circle whose center is outside the bbox but overlaps a corner', () => {
    // Just south-west of Sweden's south-west corner (55.3N, 10.9W) --
    // distance to the corner point itself.
    const dLatNm = (55.3 - 55.0) * 60 // 18nm
    const dLonNm = (10.9 - 10.5) * nmPerDegLonForTest(55.0) // ~13.8nm
    const distNm = Math.hypot(dLatNm, dLonNm)
    expect(circleIntersectsBbox(55.0, 10.5, distNm + 1, SWEDEN_BBOX)).toBe(true)
    expect(circleIntersectsBbox(55.0, 10.5, distNm - 1, SWEDEN_BBOX)).toBe(false)
  })
})

function nmPerDegLonForTest(atLatDeg: number): number {
  return 60 * Math.cos((atLatDeg * Math.PI) / 180)
}

describe('pointNearBbox', () => {
  it('accepts a point inside the bbox with zero margin', () => {
    expect(pointNearBbox(59.65, 17.9, 0, SWEDEN_BBOX)).toBe(true)
  })

  it('rejects a point well outside the bbox even with a generous margin', () => {
    expect(pointNearBbox(40.4, -3.7, 2, SWEDEN_BBOX)).toBe(false)
  })

  it('accepts a point just outside the bbox edge when within margin', () => {
    // 0.5deg south of the south edge (55.3 -> 54.8), margin 0.75deg.
    expect(pointNearBbox(54.8, 15.0, 0.75, SWEDEN_BBOX)).toBe(true)
  })

  it('rejects a point just outside the bbox edge when beyond margin', () => {
    expect(pointNearBbox(54.8, 15.0, 0.1, SWEDEN_BBOX)).toBe(false)
  })
})

describe('polygonNearBbox', () => {
  it('accepts a polygon with at least one vertex inside the bbox', () => {
    const poly: NotamPolygonGeometry = {
      type: 'Polygon',
      coordinates: [[[5.0, 50.0], [16.0, 60.0], [5.0, 60.0], [5.0, 50.0]]], // one vertex (16,60) is inside SWEDEN_BBOX
    }
    expect(polygonNearBbox(poly, 0, SWEDEN_BBOX)).toBe(true)
  })

  it('rejects a polygon entirely far from the bbox', () => {
    const poly: NotamPolygonGeometry = {
      type: 'Polygon',
      coordinates: [[[-10.0, 40.0], [-9.0, 40.0], [-9.0, 41.0], [-10.0, 40.0]]], // Spain/Portugal area
    }
    expect(polygonNearBbox(poly, 0.75, SWEDEN_BBOX)).toBe(false)
  })

  it('uses the vertex nearest the bbox, not a centroid average', () => {
    // A large polygon whose centroid sits far outside the bbox but whose
    // nearest vertex reaches just inside it -- a centroid-only test would
    // incorrectly reject this; a per-vertex test correctly accepts it.
    const poly: NotamPolygonGeometry = {
      type: 'Polygon',
      coordinates: [[[0.0, 40.0], [24.0, 69.0], [0.0, 69.0], [0.0, 40.0]]],
    }
    expect(polygonNearBbox(poly, 0, SWEDEN_BBOX)).toBe(true)
  })

  it('handles MultiPolygon by checking every constituent polygon', () => {
    const poly: NotamPolygonGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[-10.0, 40.0], [-9.0, 40.0], [-9.0, 41.0], [-10.0, 40.0]]], // far away
        [[[17.0, 59.0], [17.1, 59.0], [17.1, 59.1], [17.0, 59.0]]],   // inside Sweden
      ],
    }
    expect(polygonNearBbox(poly, 0, SWEDEN_BBOX)).toBe(true)
  })
})
