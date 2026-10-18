/**
 * Automatic cruise level for a newly created route leg (web MapView.tsx,
 * native MapScreen.tsx, via each app's useAutoCruiseLevel hook).
 *
 * When a leg is appended or inserted, its planned altitude is compared with
 * the highest terrain and obstacle under it plus a clearance. If the plan
 * is lower, the leg's altitude is raised to the safe value (rounded up to
 * the next 100 ft) and the user is told. Only new legs are touched: a leg
 * the user has already set, or one whose endpoints merely moved, keeps its
 * altitude. The pre-flight check still reports anything below MSA.
 */

import type { RouteWaypoint } from './types'

/** Clearance above the highest terrain sample under the leg. Same figure
 *  as the Virtual Radar MSA line (virtualRadarCalc.ts MSA_CLEARANCE_FT). */
export const TERRAIN_CLEARANCE_FT = 1000
/** Clearance above the highest obstacle tip in the leg's corridor. */
export const OBSTACLE_CLEARANCE_FT = 500

const roundUp100 = (ft: number) => Math.ceil(ft / 100) * 100

/** Lowest altitude (ft AMSL, multiple of 100) that clears the terrain and
 *  obstacles given. 0 when there is nothing to clear (sea-level leg, no
 *  obstacles). */
export function requiredLegAltFt(
  terrainElevFt: readonly number[],
  obstacleTipFt: readonly number[],
): number {
  let maxTerrain = 0
  for (const e of terrainElevFt) if (e > maxTerrain) maxTerrain = e
  let maxObstacle = 0
  for (const t of obstacleTipFt) if (t > maxObstacle) maxObstacle = t
  const forTerrain  = maxTerrain  > 0 ? roundUp100(maxTerrain)  + TERRAIN_CLEARANCE_FT  : 0
  const forObstacle = maxObstacle > 0 ? roundUp100(maxObstacle) + OBSTACLE_CLEARANCE_FT : 0
  return Math.max(forTerrain, forObstacle)
}

const samePos = (a: RouteWaypoint, b: RouteWaypoint) => a.lat === b.lat && a.lng === b.lng

/** Leg indices created by going from `prev` to `next` through a single
 *  append or insert of one waypoint. Empty for any other change (move,
 *  remove, load, reorder), so only genuinely new legs get a level. */
export function newLegsAfterChange(prev: readonly RouteWaypoint[], next: readonly RouteWaypoint[]): number[] {
  if (next.length !== prev.length + 1 || next.length < 2) return []
  // First index where the lists diverge is where the point went in; the
  // rest of `next` must match the rest of `prev`.
  let k = 0
  while (k < prev.length && samePos(prev[k], next[k])) k++
  for (let i = k; i < prev.length; i++) if (!samePos(prev[i], next[i + 1])) return []
  const legs: number[] = []
  if (k > 0) legs.push(k - 1)
  if (k < next.length - 1) legs.push(k)
  return legs
}

/** Toast text for a raised leg. */
export function autoLevelMessage(fromName: string, toName: string, altFt: number): string {
  return `${fromName} \u2192 ${toName} raised to ${altFt.toLocaleString('en-US')} ft for terrain/obstacle clearance`
}
