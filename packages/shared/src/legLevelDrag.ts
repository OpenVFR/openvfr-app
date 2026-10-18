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
