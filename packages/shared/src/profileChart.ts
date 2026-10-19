/**
 * profileChart — scales, ticks and path helpers for the Virtual Radar /
 * Vertical Profile (web VirtualRadar.tsx, native VerticalProfile.tsx).
 *
 * Both apps draw the chart as plain SVG on top of this module: it owns the
 * geometry (plot rectangle, NM/ft -> px mapping, axis ticks, polyline paths)
 * so the two renderers only differ in their SVG element types and gesture
 * handling. Everything here is pure and platform-free.
 */

export interface ChartMargin { top: number; right: number; bottom: number; left: number }

export interface ProfileChartLayout {
  /** Full drawn width in px (plot + margins); wider than the viewport when scrollable. */
  contentW: number
  plotW: number
  plotH: number
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
  /** True when the content is wider than the viewport. */
  scrollable: boolean
  totalNm: number
  yMax: number
  /** NM along the route -> px from the content's left edge. */
  xOf: (distNm: number) => number
  /** Feet AMSL -> px from the top. */
  yOf: (altFt: number) => number
  /** px from the content's left edge -> NM along the route, clamped to [0, totalNm]. */
  nmAtX: (px: number) => number
}

/**
 * Plot geometry for a route of `totalNm` drawn into a viewport `viewportW` px
 * wide. The plot never gets narrower than `minPxPerNm` per NM: a long route
 * grows the content past the viewport (and the caller scrolls it) instead of
 * being squeezed until short legs and their labels become unreadable.
 */
export function profileChartLayout(o: {
  viewportW: number
  height: number
  margin: ChartMargin
  totalNm: number
  yMax: number
  minPxPerNm: number
}): ProfileChartLayout {
  const { viewportW, height, margin: m, totalNm, yMax, minPxPerNm } = o
  const availablePlotW = Math.max(0, viewportW - m.left - m.right)
  const plotW = Math.max(availablePlotW, totalNm * minPxPerNm)
  const plotH = Math.max(0, height - m.top - m.bottom)
  const contentW = plotW + m.left + m.right
  const plotLeft = m.left
  const plotTop = m.top
  const plotBottom = m.top + plotH
  return {
    contentW, plotW, plotH, plotLeft, plotTop, plotBottom,
    plotRight: plotLeft + plotW,
    scrollable: contentW > viewportW + 0.5,
    totalNm, yMax,
    xOf: (distNm) => plotLeft + (totalNm > 0 ? (distNm / totalNm) * plotW : 0),
    yOf: (altFt) => plotBottom - (yMax > 0 ? (altFt / yMax) * plotH : 0),
    nmAtX: (px) => (plotW > 0 ? Math.max(0, Math.min(totalNm, ((px - plotLeft) / plotW) * totalNm)) : 0),
  }
}

/**
 * Altitude scale top: 1.5x the highest planned altitude, but always clear of
 * the terrain and at least 3000 ft, rounded up to the next 1000 ft.
 * Airspace ceilings deliberately don't count (one FL660 CTA must not flatten
 * the whole chart; bands are clamped to the top instead).
 */
export function profileYMax(maxPlannedAltFt: number, terrainPts: readonly { elevFt: number }[]): number {
  const planned = Math.max(maxPlannedAltFt, 1000)
  const maxTerrain = terrainPts.reduce((m, p) => Math.max(m, p.elevFt), 0)
  const raw = Math.max(planned * 1.5, maxTerrain * 1.2, 3000)
  return Math.ceil(raw / 1000) * 1000
}

/** 1-2-5-10 step for roughly `targetTicks` intervals over `range`. */
export function niceStep(range: number, targetTicks: number): number {
  if (!(range > 0) || !(targetTicks > 0)) return 1
  const raw = range / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  return step * mag
}

/**
 * Altitude axis ticks from 0 to `yMax`. Levels are assigned in round
 * increments, so ticks land on FL020/FL025/FL050-style values, never below a
 * 500 ft step (anything finer means nothing on a VFR profile).
 */
export function altitudeTicks(yMax: number, targetTicks = 5): number[] {
  const step = yMax > 0 ? Math.max(500, niceStep(yMax, targetTicks)) : 500
  const ticks: number[] = []
  for (let v = 0; v <= yMax + 1e-6; v += step) ticks.push(Math.round(v))
  return ticks
}

/** Altitude tick label: flight-level style from 1000 ft, plain feet below. */
export function formatAltitudeTick(ft: number): string {
  return ft >= 1000 ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}` : `${Math.round(ft)}`
}

/**
 * Distance axis ticks in display units (NM or km), from 0 to `domainMax`, on
 * a 1-2-5 step. Ticks in the last `edgeReserveFrac` of the axis are dropped:
 * that strip holds the unit label ("NM"/"km"), and a tick number there would
 * be painted through it.
 */
export function distanceTicks(domainMax: number, targetTicks = 7, edgeReserveFrac = 0.08): number[] {
  if (!(domainMax > 0)) return [0]
  const step = Math.max(1, niceStep(domainMax, targetTicks))
  const limit = domainMax * (1 - edgeReserveFrac)
  const ticks: number[] = []
  for (let v = 0; v <= limit + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000)
  return ticks
}

/** `M x,y L x,y ...` through the points, or '' for fewer than two. */
export function polylinePath(
  points: readonly { distNm: number; altFt: number }[],
  xOf: (nm: number) => number,
  yOf: (ft: number) => number,
): string {
  if (points.length < 2) return ''
  return 'M' + points.map((p) => `${xOf(p.distNm).toFixed(1)},${yOf(p.altFt).toFixed(1)}`).join(' L')
}

/** Closed area under a ground profile, down to 0 ft, across [0, totalNm]. */
export function groundAreaPath(
  terrainPts: readonly { distNm: number; elevFt: number }[],
  xOf: (nm: number) => number,
  yOf: (ft: number) => number,
  totalNm: number,
  dx = 0,
  dy = 0,
): string {
  if (terrainPts.length === 0) return ''
  const base = yOf(0).toFixed(1)
  const pts = terrainPts.map((p) => `${(xOf(p.distNm) + dx).toFixed(1)},${(yOf(p.elevFt) + dy).toFixed(1)}`)
  return `M${xOf(0).toFixed(1)},${base} L${pts.join(' L')} L${xOf(totalNm).toFixed(1)},${base} Z`
}

/** Below-MSA warnings are suppressed this close to departure and destination:
 *  climbing out through MSA and descending through it on approach is normal. */
export const BELOW_MSA_ENDPOINT_SUPPRESS_NM = 5

/**
 * Stretches of the planned line that sit below MSA, as runs of points.
 * Each run includes its safe neighbours on both sides so the red overlay
 * starts and ends exactly on the planned line instead of leaving a gap.
 */
export function belowMsaRuns(o: {
  distNms: readonly number[]
  plannedAlts: readonly number[]
  getMsa: (distNm: number) => number
  totalNm: number
  suppressNm?: number
}): { distNm: number; altFt: number }[][] {
  const { distNms, plannedAlts, getMsa, totalNm } = o
  const suppress = o.suppressNm ?? BELOW_MSA_ENDPOINT_SUPPRESS_NM
  const below = distNms.map((d, i) => {
    const msa = getMsa(d)
    const nearEndpoint = d < suppress || totalNm - d < suppress
    return msa > 0 && plannedAlts[i] < msa && !nearEndpoint
  })
  const runs: { distNm: number; altFt: number }[][] = []
  let cur: { distNm: number; altFt: number }[] = []
  for (let i = 0; i < distNms.length; i++) {
    const include = below[i] || (i > 0 && below[i - 1]) || (i < below.length - 1 && below[i + 1])
    if (include) {
      cur.push({ distNm: distNms[i], altFt: plannedAlts[i] })
    } else if (cur.length > 0) {
      runs.push(cur)
      cur = []
    }
  }
  if (cur.length > 0) runs.push(cur)
  return runs.filter((r) => r.length >= 2)
}

/** Index of the sample nearest to `distNm` in an ascending list (binary search). */
export function nearestSampleIndex(distNms: readonly number[], distNm: number): number {
  if (distNms.length === 0) return -1
  let lo = 0, hi = distNms.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (distNms[mid] < distNm) lo = mid
    else hi = mid
  }
  return Math.abs(distNms[lo] - distNm) <= Math.abs(distNms[hi] - distNm) ? lo : hi
}
