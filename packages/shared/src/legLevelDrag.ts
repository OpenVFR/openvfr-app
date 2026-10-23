/**
 * Dragging a route leg up or down in the Virtual Radar / Vertical Profile to
 * change its planned level. Shared by web (VirtualRadar.tsx) and native
 * (VerticalProfile.tsx); the gesture and drawing live in each app.
 *
 * Rules:
 * - The level follows the finger 1:1 (the line you grab stays under it). The
 *   reference planner moves it at a quarter (up) / half (down) of the travel;
 *   on a phone that made the level run away from the finger and made lowering
 *   it a long drag, so we do not copy that part.
 * - The drag starts from the altitude drawn under the finger, not from the
 *   leg's requested level: a level the aircraft cannot reach on that distance
 *   sits far above the drawn line and made the line jump to the top.
 * - Snaps to 100 ft, capped at LEVEL_MAX_FT. No step-size mode: on a touch screen a mode button is easy to
 *   leave on, and a second finger would pinch the chart instead.
 * - Dragging below the lowest step clears the leg's override (`null`), so
 *   the leg falls back to the route's default level.
 * - Only new levels differing from the current one are committed.
 */

import type { ProfilePoint, MsaPoint } from './virtualRadarCalc'
import { BELOW_MSA_ENDPOINT_SUPPRESS_NM } from './profileChart'

export const LEVEL_STEP_FT = 100
export const LEVEL_MAX_FT = 50_000
/** Finger travel → level travel ratios (see module header). */
export const DRAG_UP_RATIO = 1
export const DRAG_DOWN_RATIO = 1
/** Finger travel (px) below which a press-and-release is not an edit. */
export const DRAG_MIN_MOVE_PX = 10

/** A requested level the drawn path stays this far below is "not reached". */
export const UNREACHED_MARGIN_FT = 150

/**
 * Legs whose requested level the projected flight path never gets near (a short
 * leg cannot climb to 3500 ft): index -> requested level, so the chart can say
 * so instead of showing a line that silently ignores the level.
 */
export function unreachedLegs(
  spans: readonly LegSpan[],
  pathPts: readonly { distNm: number; altFt: number }[],
): { legIndex: number; levelFt: number; reachedFt: number }[] {
  const out: { legIndex: number; levelFt: number; reachedFt: number }[] = []
  for (const s of spans) {
    let max = -Infinity
    for (const p of pathPts) if (p.distNm >= s.fromNm - 0.01 && p.distNm <= s.toNm + 0.01 && p.altFt > max) max = p.altFt
    if (max === -Infinity) continue
    if (s.altFt - max > UNREACHED_MARGIN_FT) out.push({ legIndex: s.legIndex, levelFt: s.altFt, reachedFt: Math.round(max / 100) * 100 })
  }
  return out
}

/** Altitude (ft, rounded to the level step) drawn at screen height `y`, given the
 *  chart's ground line `y0` and scale `pxPerFt`. Never below 0. */
export function altAtY(y: number, y0: number, pxPerFt: number): number {
  if (pxPerFt <= 0) return 0
  return Math.max(0, Math.round((y0 - y) / pxPerFt / LEVEL_STEP_FT) * LEVEL_STEP_FT)
}

export type LegSpan = { legIndex: number; fromNm: number; toNm: number; altFt: number }

/** One span per leg from the step-function altitude profile (two points per
 *  leg: start and end at the same altitude). */
export function legSpans(altitudeProfile: readonly ProfilePoint[]): LegSpan[] {
  const out: LegSpan[] = []
  for (let i = 0; i + 1 < altitudeProfile.length; i += 2) {
    out.push({ legIndex: i / 2, fromNm: altitudeProfile[i].distNm, toNm: altitudeProfile[i + 1].distNm, altFt: altitudeProfile[i].altFt })
  }
  return out
}

/** Candidate level for a drag that started at `startAltFt` and has moved
 *  `dyPx` pixels (positive = down the screen) on a chart with `pxPerFt`
 *  vertical scale. `null` means "clear the override". */
export function dragLevelFt(startAltFt: number, dyPx: number, pxPerFt: number): number | null {
  const snapped = dragShownFt(startAltFt, dyPx, pxPerFt)
  if (snapped < LEVEL_STEP_FT) return null
  return snapped
}

/** The level under the finger, snapped to the step, never below 0 (what the
 *  preview line is drawn at; `dragLevelFt` turns anything below the lowest
 *  step into "clear the override"). */
export function dragShownFt(startAltFt: number, dyPx: number, pxPerFt: number, stepFt: number = LEVEL_STEP_FT): number {
  if (pxPerFt <= 0) return startAltFt
  const effDy = dyPx < 0 ? dyPx * DRAG_UP_RATIO : dyPx * DRAG_DOWN_RATIO
  const raw = startAltFt - effDy / pxPerFt
  return Math.min(LEVEL_MAX_FT, Math.max(0, Math.round(raw / stepFt) * stepFt))
}

/** The step-function altitude profile with one leg moved to `altFt`: feed it to the flight-path
 *  projection to preview the climbs and descents a drag would produce before it is committed. */
export function withLegLevel(altitudeProfile: readonly ProfilePoint[], legIndex: number, altFt: number): ProfilePoint[] {
  return altitudeProfile.map((p, i) => (Math.floor(i / 2) === legIndex ? { ...p, altFt } : p))
}

/** Highest MSA within a leg's span (0 when there is no MSA data there). */
export function legMsaFt(msaPts: readonly MsaPoint[], fromNm: number, toNm: number): number {
  let max = 0
  for (const p of msaPts) {
    if (p.distNm < fromNm - 0.01 || p.distNm > toNm + 0.01) continue
    if (p.msaFt > max) max = p.msaFt
  }
  return max
}

/** Level label: `3,500 ft`, or `FL055` style is left to the caller's axis
 *  convention; keep feet here so the label matches the leg editor. */
export function levelLabel(altFt: number): string {
  return `${altFt.toLocaleString('en-US')} ft`
}

/**
 * MSA (ft, multiple of 100; 0 = none known) of every leg: the highest MSA
 * sample inside the leg's span. A leg shorter than the sample spacing has no
 * sample of its own, so it falls back to the MSA at its midpoint.
 */
export function legMsaList(
  spans: readonly LegSpan[],
  msaPts: readonly MsaPoint[],
  msaAt: (distNm: number) => number,
): number[] {
  return spans.map((s) => Math.max(legMsaFt(msaPts, s.fromNm, s.toNm), msaAt((s.fromNm + s.toNm) / 2)))
}

/**
 * True when a leg planned at `altFt` is below its MSA and should be flagged.
 * Climb-out and approach are normal below MSA, so a leg lying entirely
 * within BELOW_MSA_ENDPOINT_SUPPRESS_NM of departure or destination is not
 * flagged (same rule as the chart's red line).
 */
export function legBelowMsa(span: LegSpan, totalNm: number, altFt: number, msaFt: number): boolean {
  if (msaFt <= 0 || altFt >= msaFt) return false
  return legMsaApplies(span, totalNm)
}

/** False for a leg lying entirely within the endpoint suppression distance of
 *  departure or destination, where flying below MSA is normal. */
export function legMsaApplies(span: LegSpan, totalNm: number): boolean {
  const s = BELOW_MSA_ENDPOINT_SUPPRESS_NM
  return !(span.toNm <= s || span.fromNm >= totalNm - s)
}

export type PhaseMark = { kind: 'TOC' | 'TOD'; distNm: number; altFt: number }

/** Top of climb / top of descent along a flown path: the point where a climb stops
 *  (levelling off, or turning straight into a descent) and where a descent starts
 *  from level flight. Changes smaller than `flatFt` between samples count as level. */
export function verticalPhaseMarks(
  pathPts: readonly { distNm: number; altFt: number }[],
  flatFt = 5,
): PhaseMark[] {
  const out: PhaseMark[] = []
  let phase: 'up' | 'flat' | 'down' = 'flat'
  for (let i = 1; i < pathPts.length; i++) {
    const d = pathPts[i].altFt - pathPts[i - 1].altFt
    const next: 'up' | 'flat' | 'down' = d > flatFt ? 'up' : d < -flatFt ? 'down' : 'flat'
    if (next === phase) continue
    const prev = pathPts[i - 1]
    if (phase === 'up') out.push({ kind: 'TOC', distNm: prev.distNm, altFt: prev.altFt })
    if (next === 'down' && phase !== 'up') out.push({ kind: 'TOD', distNm: prev.distNm, altFt: prev.altFt })
    phase = next
  }
  return out
}
