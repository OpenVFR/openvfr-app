/**
 * deriveWxDisplay — pure derivation of everything the Wx display needs
 * (decoded METAR, effective wind for whichever source tab is selected, TAF
 * periods, per-runway wind ends, compass runway selection) from a raw
 * WxResolved + an ambient (Open-Meteo) reading + a runway list.
 *
 * Extracted from AerodromePopup.tsx so both it (Info tab crosswind display,
 * tab-dot colour, map runway-highlight reporting) and any other consumer
 * needing "this aerodrome's weather, decoded" without a full aerodrome tap
 * (e.g. VicinityBriefSheet.tsx's Wx tab) share one source of truth instead
 * of re-deriving METAR/TAF parsing and effective-wind logic.
 *
 * `wxSource` picks which tab's wind is authoritative for effectiveWind (and
 * therefore for allRunwayWindEnds/the favoured-runway-end highlight): the
 * real METAR's own wind for 'metar' (however far away that station is --
 * no silent auto-swap to modelled wind at any distance, unlike the old
 * single-source design), Open-Meteo's ambientWx for 'station'. metar/
 * tafPeriods/usingFallbackWx always reflect `wx` regardless of wxSource --
 * only effectiveWind/windIsModelled switch.
 *
 * `selectedRunwayDesig` only affects the compass-specific fields
 * (compassRunway/compassRunwayWindEnds/compassFavoredEnd/primaryRunwayHeading)
 * — pass null when the caller doesn't have (or care about) a runway picker;
 * those fields still default sensibly to the longest runway.
 */

import {
  decodeMetar, parseMetarWind, type WxResolved, type ParsedWind, type MetarDecoded,
} from '@open-vfr/shared/fetchWx'
import type { AmbientWx } from '@open-vfr/shared/fetchWind'
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
  ambientWind:            ParsedWind | null
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
  wxSource:            'metar' | 'station' = 'metar',
  ambientWx:           AmbientWx | null = null,
): WxDisplay {
  const metar = wx?.metar ? decodeMetar(wx.metar) : null
  const surfaceWind = metar ? parseMetarWind(metar.wind) : null
  const ambientWind: ParsedWind | null = ambientWx
    ? { dirDeg: ambientWx.dirDeg, speedKt: ambientWx.speedKts, gustKt: ambientWx.gustKts, variable: false, calm: ambientWx.speedKts === 0 }
    : null
  const effectiveWind = wxSource === 'station' ? ambientWind : surfaceWind
  const windIsModelled = wxSource === 'station'
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
    metar, surfaceWind, ambientWind, effectiveWind, windIsModelled, tafPeriods, usingFallbackWx,
    allRunwayWindEnds, longestRunway, compassRunway, compassRunwayWindEnds, compassFavoredEnd, primaryRunwayHeading,
  }
}
