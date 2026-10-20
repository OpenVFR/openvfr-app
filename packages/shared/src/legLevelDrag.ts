/**
 * Dragging a route leg up or down in the Virtual Radar / Vertical Profile to
 * change its planned level. Shared by web (VirtualRadar.tsx) and native
 * (VerticalProfile.tsx); the gesture and drawing live in each app.
 *
 * Rules:
 * - The level moves at a fraction of the finger: a quarter of the travel
 *   when dragging up, half when dragging down, so a tall chart range on a
 *   small panel is not twitchy.
 * - Snaps to 100 ft, capped at LEVEL_MAX_FT.
 * - Dragging below the lowest step clears the leg's override (`null`), so
 *   the leg falls back to the route's default level.
 * - Only new levels differing from the current one are committed.
 */

import type { ProfilePoint, MsaPoint } from './virtualRadarCalc'
import { BELOW_MSA_ENDPOINT_SUPPRESS_NM } from './profileChart'

export const LEVEL_STEP_FT = 100
export const LEVEL_MAX_FT = 50_000
/** Finger travel → level travel ratios (see module header). */
export const DRAG_UP_RATIO = 0.25
export const DRAG_DOWN_RATIO = 0.5

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
  if (pxPerFt <= 0) return startAltFt
  const effDy = dyPx < 0 ? dyPx * DRAG_UP_RATIO : dyPx * DRAG_DOWN_RATIO
  const raw = startAltFt - effDy / pxPerFt
  const snapped = Math.round(raw / LEVEL_STEP_FT) * LEVEL_STEP_FT
  if (snapped < LEVEL_STEP_FT) return null
  return Math.min(snapped, LEVEL_MAX_FT)
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
