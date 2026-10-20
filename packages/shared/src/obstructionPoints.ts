/**
 * Obstacle points for the in-flight proximity alert: the obstacles file plus
 * the landmarks file (masts, chimneys, churches, ...), each with a tip
 * altitude. Unknown heights get the per-kind estimate (obstacleHeights), the
 * same rule the vertical profile uses, so an obstacle without a recorded
 * height is no longer treated as flush with the ground.
 *
 * Landmarks carry no ground elevation; the terrain maximum grid (conservative:
 * highest terrain in a ~460 m cell) stands in. Without a grid their ground is
 * unknown (`groundKnown` false): the tip is then taken relative to the ground
 * under the aircraft (see obstructionTipFt), valid because alerts only look
 * 1 NM around the aircraft.
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
  /** Ground elevation AMSL; 0 when `groundKnown` is false. */
  elevFt: number
  /** Tip AMSL; when `groundKnown` is false, only the height above ground. */
  tipFt: number
  groundKnown: boolean
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
      const groundKnown = elevFt != null
      const rawH = p['height_m'] == null ? null : Number(p['height_m'])
      const kind = String(p['kind'] ?? 'other')
      const name = String(p['name'] ?? '').trim()
      const h = effectiveHeight(kind, rawH)
      pts.push({
        key: `${prefix}-${i}`, lat, lng, kind, name, elevFt: elevFt ?? 0,
        tipFt: (elevFt ?? 0) + Math.round(h.heightM * FT_PER_M), groundKnown,
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

/**
 * Tip altitude AMSL to compare the aircraft against, or null when it cannot be
 * known (ground unknown and no terrain under the aircraft either). Unknown
 * ground is taken as the ground under the aircraft.
 */
export function obstructionTipFt(o: ObstructionPoint, ownTerrainFt: number | null | undefined): number | null {
  if (o.groundKnown) return o.tipFt
  if (ownTerrainFt == null || !Number.isFinite(ownTerrainFt)) return null
  return Math.max(0, ownTerrainFt) + o.tipFt
}

export type GroupableAlert = {
  key: string
  kind: string
  name: string
  elevationFt: number
  tipFt: number
  estimated: boolean
  distNm: number
}

/**
 * One alert per obstacle kind instead of one per obstacle (a mast field would
 * otherwise stack five identical cards): the nearest obstacle gives the
 * distance and name, the highest tip is shown, `count` says how many. The key
 * is per kind, so dismissing silences the whole group.
 */
export function groupObstructionAlerts<T extends GroupableAlert>(items: readonly T[]): Array<T & { count: number }> {
  const byKind = new Map<string, T[]>()
  for (const it of items) {
    const arr = byKind.get(it.kind)
    if (arr) arr.push(it); else byKind.set(it.kind, [it])
  }
  const out: Array<T & { count: number }> = []
  for (const [kind, arr] of byKind) {
    const nearest = arr.reduce((a, b) => (b.distNm < a.distNm ? b : a))
    const highest = arr.reduce((a, b) => (b.tipFt > a.tipFt ? b : a))
    out.push({ ...nearest, key: `kind:${kind}`, tipFt: highest.tipFt, estimated: highest.estimated, elevationFt: highest.elevationFt, count: arr.length })
  }
  return out.sort((a, b) => a.distNm - b.distNm)
}
