/**
 * On-map leg label text, shared by web (MapView.tsx) and native
 * (AviationMap.tsx). Three variants from richest to shortest; the map
 * places each along the leg with MapLibre `symbol-placement: line-center`,
 * so a label is only drawn when it fits the leg's on-screen length, and
 * collision order lets the richest one that fits win.
 */

import { nmToDisplay, distLabel, type DistanceUnit } from './units'

export type LegLabelInput = {
  magHdgDeg: number
  distNm: number
  /** Planned speed (kt) for the time estimate; omitted when unknown. */
  speedKts?: number
  unit?: DistanceUnit
}

export type LegLabelVariants = { full: string; mid: string; short: string }

const SEP = '  \u00b7  '

/** Leg time at `speedKts` ground speed as `8 min` / `1 h 05`. */
export function formatLegTime(distNm: number, speedKts: number): string {
  const min = Math.round((distNm / speedKts) * 60)
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

export function legLabelVariants(input: LegLabelInput): LegLabelVariants {
  const unit = input.unit ?? 'nm'
  const short = `${Math.round(input.magHdgDeg).toString().padStart(3, '0')}\u00b0`
  const d = nmToDisplay(input.distNm, unit)
  const dist = `${d < 10 ? d.toFixed(1) : Math.round(d)} ${distLabel(unit)}`
  const mid = `${short}${SEP}${dist}`
  const full = input.speedKts && input.speedKts > 0
    ? `${mid}${SEP}${formatLegTime(input.distNm, input.speedKts)}`
    : mid
  return { full, mid, short }
}
