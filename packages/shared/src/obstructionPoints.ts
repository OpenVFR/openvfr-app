/**
 * Obstacle points for the in-flight proximity alert: the obstacles file plus
 * the landmarks file (masts, chimneys, churches, ...), each with a tip
 * altitude. Unknown heights get the per-kind estimate (obstacleHeights), the
 * same rule the vertical profile uses, so an obstacle without a recorded
 * height is no longer treated as flush with the ground.
 *
 * Landmarks carry no ground elevation; the terrain maximum grid (conservative:
 * highest terrain in a ~460 m cell) stands in. Without a grid they are skipped
 * (a guessed ground would give false alerts or none).
 */
import type { FeatureCollection, Point } from 'geojson'
import { effectiveHeight, FT_PER_M } from './obstacleHeights'
import { mefFtAt, type MefGrid } from './mefGrid'

export type ObstructionPoint = {
  key: string
  lat: number
  lng: number
  kind: string
  name: string
  elevFt: number
  tipFt: number
  /** True when the height is the per-kind estimate, not a recorded value. */
  estimated: boolean
}

function gridGroundFt(grids: readonly MefGrid[], lat: number, lng: number): number | null {
  for (const g of grids) {
    const v = mefFtAt(g, lat, lng)
    if (v != null) return v
  }
  return null
}

export function buildObstructionPoints(
  obstacles: FeatureCollection | null,
  landmarks: FeatureCollection | null,
  grids: readonly MefGrid[],
): ObstructionPoint[] {
  const pts: ObstructionPoint[] = []
  const add = (fc: FeatureCollection | null, prefix: string, ground: (lat: number, lng: number, elevProp: unknown) => number | null) => {
    if (!fc) return
    fc.features.forEach((f, i) => {
      if (f.geometry?.type !== 'Point') return
      const [lng, lat] = (f.geometry as Point).coordinates
      const p = (f.properties ?? {}) as Record<string, unknown>
      const elevFt = ground(lat, lng, p['elevation_ft'])
      if (elevFt == null) return
      const rawH = p['height_m'] == null ? null : Number(p['height_m'])
      const kind = String(p['kind'] ?? 'other')
      const name = String(p['name'] ?? '').trim()
      const h = effectiveHeight(kind, rawH)
      pts.push({
        key: `${prefix}-${i}`, lat, lng, kind, name, elevFt,
        tipFt: elevFt + Math.round(h.heightM * FT_PER_M),
        estimated: h.estimated,
      })
    })
  }
  add(obstacles, 'obs', (lat, lng, e) => {
    const v = Number(e ?? 0)
    // A recorded 0 ft elevation is usually "unknown": prefer the grid if present.
    return v > 0 ? v : (gridGroundFt(grids, lat, lng) ?? 0)
  })
  add(landmarks, 'lm', (lat, lng) => gridGroundFt(grids, lat, lng))
  return pts
}
