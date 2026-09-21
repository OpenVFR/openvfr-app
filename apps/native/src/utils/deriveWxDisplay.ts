/**
 * deriveWxDisplay — pure derivation of everything the Wx display needs
 * (decoded METAR, effective wind incl. modelled fallback, TAF periods,
 * per-runway wind ends, compass runway selection) from a raw WxResolved +
 * a runway list.
 *
 * Extracted from AerodromePopup.tsx so both it (Info tab crosswind display,
 * tab-dot colour, map runway-highlight reporting) and any other consumer
 * needing "this aerodrome's weather, decoded" without a full aerodrome tap
 * (e.g. VicinityBriefSheet.tsx's Wx tab) share one source of truth instead
 * of re-deriving METAR/TAF parsing and effective-wind fallback logic.
 *
 * `selectedRunwayDesig` only affects the compass-specific fields
 * (compassRunway/compassRunwayWindEnds/compassFavoredEnd/primaryRunwayHeading)
 * — pass null when the caller doesn't have (or care about) a runway picker;
 * those fields still default sensibly to the longest runway.
 */

import {
  decodeMetar, parseMetarWind, type WxResolved, type ParsedWind, type MetarDecoded,
} from '@open-vfr/shared/fetchWx'
import { computeRunwayWind, effectiveMagBrg, type RunwayWindEnd } from '@open-vfr/shared/runwayWind'
import { parseTaf, type TafPeriod } from '@open-vfr/shared/parseTaf'
import type { RunwayHeading } from '../components/WindGauges'

interface Threshold {
  designator: string
  lat: number
  lon: number
  true_brg: number | null
  mag_brg: number | null
}

interface Runway {
  designator: string
  length_m?: number
  surface?: string
  thresholds?: Threshold[]
}

export interface WxDisplay {
  metar:                MetarDecoded | null
  surfaceWind:           ParsedWind | null
  modelWind:              ParsedWind | null
  effectiveWind:          ParsedWind | null
  windIsModelled:         boolean
  tafPeriods:             TafPeriod[] | null
  usingFallbackWx:        boolean
  allRunwayWindEnds:      RunwayWindEnd[]
  longestRunway:          Runway | undefined
  compassRunway:          Runway | undefined
  compassRunwayWindEnds:  RunwayWindEnd[]
  compassFavoredEnd:      RunwayWindEnd | null
  primaryRunwayHeading:   RunwayHeading | null
}

export function deriveWxDisplay(
  wx:                  WxResolved | null,
  runways:             Runway[],
  icao:                string | null | undefined,
  selectedRunwayDesig: string | null = null,
): WxDisplay {
  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null
  const modelWind: ParsedWind | null = wx?.modelWind
    ? { dirDeg: wx.modelWind.dirDeg, speedKt: wx.modelWind.speedKts, gustKt: null, variable: false, calm: wx.modelWind.speedKts === 0 }
    : null
  const effectiveWind = modelWind ?? surfaceWind
  const windIsModelled = !!modelWind
  const tafPeriods: TafPeriod[] | null = wx?.taf ? parseTaf(wx.taf) : null
  const usingFallbackWx = !!wx && icao != null && wx.sourceIcao !== icao

  const allRunwayWindEnds = runways.flatMap((rwy) => computeRunwayWind(rwy.thresholds ?? [], effectiveWind))

  const longestRunway = [...runways].sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0))[0]
  const compassRunway = selectedRunwayDesig != null
    ? runways.find((r) => r.designator === selectedRunwayDesig) ?? longestRunway
    : longestRunway
  const compassRunwayWindEnds = compassRunway ? computeRunwayWind(compassRunway.thresholds ?? [], effectiveWind) : []
  const compassFavoredEnd = compassRunwayWindEnds.find((e) => e.favored) ?? null

  const primaryRunwayHeading: RunwayHeading | null = (() => {
    if (!compassRunway?.thresholds || compassRunway.thresholds.length === 0) return null
    const [t0, t1] = compassRunway.thresholds
    if (!t0) return null
    const brg = effectiveMagBrg(t0.mag_brg, t0.true_brg)
    if (brg == null) return null
    return { designators: [t0.designator, t1?.designator ?? '—'], headingDeg: brg }
  })()

  return {
    metar, surfaceWind, modelWind, effectiveWind, windIsModelled, tafPeriods, usingFallbackWx,
    allRunwayWindEnds, longestRunway, compassRunway, compassRunwayWindEnds, compassFavoredEnd, primaryRunwayHeading,
  }
}
