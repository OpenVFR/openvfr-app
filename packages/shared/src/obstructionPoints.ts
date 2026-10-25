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

/** Distance as the alert shows it ("<0.1" or one decimal, NM). */
export function obstructionDistLabel(distNm: number): string {
  return distNm < 0.1 ? '<0.1' : distNm.toFixed(1)
}

/**
 * Signature of what the obstruction alerts show. The position hooks only set
 * state when it changes. It uses the distance *as displayed*, not the raw
 * value: the raw distance changes on every GPS tick while an obstacle is in
 * range, so every tick's effect set state, and after 50 such ticks in a row
 * React stops with "Maximum update depth exceeded".
 */
export function obstructionAlertsSig(alerts: readonly (GroupableAlert & { count: number })[]): string {
  return alerts.map((a) => `${a.key}:${a.count}:${a.name}:${a.tipFt}:${a.elevationFt}:${a.estimated ? 1 : 0}:${obstructionDistLabel(a.distNm)}`).join('|')
}

// ── Forward-corridor filter ─────────────────────────────────────────────────
// A fixed obstacle is only a threat when the aircraft is moving towards it. A
// plain circle around the fix warns about every mast beside a parked aircraft
// or a track that is flying away, which is what turned the alert stack into
// background noise. The corridor is the straight projection of the current
// track, a fixed half-width either side of it.

/** Half-width of the corridor either side of the track, NM. */
export const OBSTRUCTION_CORRIDOR_HALF_NM = 0.5
/** Minutes of flight ahead the corridor reaches. */
export const OBSTRUCTION_LOOKAHEAD_MIN = 2
/** Reach is never shorter / longer than this, NM. */
export const OBSTRUCTION_REACH_MIN_NM = 1
export const OBSTRUCTION_REACH_MAX_NM = 5
/** Below this ground speed the aircraft is not "flying towards" anything. */
export const OBSTRUCTION_MIN_SPEED_KTS = 30
/** Anything this close is a threat regardless of heading (turns, GPS error). */
export const OBSTRUCTION_NEAR_NM = 0.25

const NM_PER_DEG = 60

/** Margin above an obstacle tip the aircraft must clear, ft. */
export const OBSTRUCTION_VERTICAL_BUFFER_FT = 500
/** Smoothed descent slower than this is treated as level flight, ft/min. */
export const OBSTRUCTION_DESCENT_MIN_FPM = 200
/** Never credit more than this much descent before reaching the obstacle, ft. */
export const OBSTRUCTION_DESCENT_MAX_FT = 1500

/**
 * Altitude to test against an obstacle tip: where a descending aircraft will be
 * when it reaches the obstacle (so a descent into the obstacle's height band
 * warns early). A climb is never credited: a level or climbing aircraft is
 * tested at its current altitude.
 */
export function obstructionRiskAltFt(altFt: number, climbRateFpm: number, distNm: number, speedKts: number): number {
  if (!(climbRateFpm <= -OBSTRUCTION_DESCENT_MIN_FPM)) return altFt
  const minutes = distNm / Math.max(speedKts, 1) * 60
  return altFt - Math.min(OBSTRUCTION_DESCENT_MAX_FT, -climbRateFpm * minutes)
}

/** Altitude that clears all of the given tips with the standard margin, rounded up to 100 ft. */
export function obstructionClearFt(highestTipFt: number): number {
  return Math.ceil((highestTipFt + OBSTRUCTION_VERTICAL_BUFFER_FT) / 100) * 100
}

/** Corridor length ahead of the aircraft, NM. */
export function obstructionReachNm(speedKts: number): number {
  const nm = (Math.max(speedKts, 0) * OBSTRUCTION_LOOKAHEAD_MIN) / 60
  return Math.min(OBSTRUCTION_REACH_MAX_NM, Math.max(OBSTRUCTION_REACH_MIN_NM, nm))
}

/**
 * Straight distance in NM when the obstacle lies in the forward corridor (or
 * within the near radius), otherwise null. `accuracyM` widens the corridor a
 * little for a poor GPS fix (noise below 30 m is ignored, the extra is capped).
 */
export function obstructionThreatDistNm(
  own: { lat: number; lng: number; trackDeg: number; speedKts: number; accuracyM?: number },
  obs: { lat: number; lng: number },
): number | null {
  if (!(own.speedKts >= OBSTRUCTION_MIN_SPEED_KTS)) return null
  const north = (obs.lat - own.lat) * NM_PER_DEG
  const east  = (obs.lng - own.lng) * NM_PER_DEG * Math.cos(((own.lat + obs.lat) / 2) * Math.PI / 180)
  const dist  = Math.hypot(north, east)
  if (dist <= OBSTRUCTION_NEAR_NM) return dist
  const t = (own.trackDeg * Math.PI) / 180
  const along = east * Math.sin(t) + north * Math.cos(t)
  const cross = Math.abs(east * Math.cos(t) - north * Math.sin(t))
  const acc   = Math.min(Math.max((own.accuracyM ?? 0) - 30, 0), 270) / 1852
  if (along < 0 || along > obstructionReachNm(own.speedKts)) return null
  if (cross > OBSTRUCTION_CORRIDOR_HALF_NM + acc) return null
  return dist
}

export type SummarizableAlert = GroupableAlert & { count: number }

export type ObstructionSummary = {
  /** Obstacles in total across kinds. */
  count: number
  /** Kinds present, most numerous first, e.g. [['mast', 5], ['church', 4]]. */
  kinds: Array<[string, number]>
  nearestNm: number
  /** Highest tip AMSL among all, and whether that value is an estimate. */
  highestTipFt: number
  estimated: boolean
  /** Altitude that clears the highest tip with the standard margin. */
  clearFt: number
  /** Alert keys to dismiss together. */
  keys: string[]
}

/** One summary for the whole set of per-kind alerts (null when empty). */
export function summarizeObstructionAlerts(alerts: readonly SummarizableAlert[]): ObstructionSummary | null {
  if (alerts.length === 0) return null
  let count = 0
  let nearestNm = Infinity
  let highest = alerts[0]
  for (const a of alerts) {
    count += a.count
    if (a.distNm < nearestNm) nearestNm = a.distNm
    if (a.tipFt > highest.tipFt) highest = a
  }
  const kinds = alerts
    .map((a): [string, number] => [a.kind, a.count])
    .sort((a, b) => b[1] - a[1])
  return { count, kinds, nearestNm, highestTipFt: highest.tipFt, estimated: highest.estimated, clearFt: obstructionClearFt(highest.tipFt), keys: alerts.map(a => a.key) }
}

const KIND_LABEL: Record<string, [string, string]> = {
  wind_turbine: ['wind turbine', 'wind turbines'],
  water_tower:  ['water tower', 'water towers'],
  church:       ['church', 'churches'],
  chimney:      ['chimney', 'chimneys'],
}
function kindLabel(kind: string, n: number): string {
  const l = KIND_LABEL[kind]
  if (l) return n === 1 ? l[0] : l[1]
  const base = kind.replace(/_/g, ' ')
  return n === 1 ? base : `${base}s`
}

/** Title and detail line for the single merged obstruction card. */
export function obstructionSummaryText(s: ObstructionSummary, singleName?: string): { title: string; meta: string } {
  const title = s.count === 1 && singleName
    ? singleName
    : s.kinds.slice(0, 3).map(([k, n]) => `${n} \u00d7 ${kindLabel(k, n)}`).join(' \u00b7 ') + (s.kinds.length > 3 ? ' \u2026' : '')
  const meta = `${s.count === 1 ? 'Top' : 'Highest top'} ${s.highestTipFt} ft${s.estimated ? ' (est.)' : ''} \u00b7 nearest ${obstructionDistLabel(s.nearestNm)} NM ahead \u00b7 climb above ${s.clearFt} ft`
  return { title, meta }
}
