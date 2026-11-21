/**
 * The words of the pre-flight warnings, in one place.
 *
 * `computeWarnings` decides WHAT is wrong and records it as a code plus parameters (`PreflightWarningItem`); `formatPreflightWarning`
 * is the only function that turns that into the English `title` and `detail` the cards show. A translation, or a different wording,
 * replaces this one function; nothing else in the check builds a sentence. Every warning keeps its `params`, so a client may format
 * it itself.
 */

import type { AssistantReview } from './types'
import { assistantReviewLabel } from './types'
import type { NotamItem } from './fetchNotam'
import { notamTitle } from './notamQCode'
import { notamSummary } from './preflightNotams'
import type { PreflightWarning, WarningFix, WarningLevel } from './preflightWarnings'
import { formatNumber } from './formatNumber'

/** Parameters per warning code. Numbers are raw values (rounding for display happens in the formatter, as before). */
export interface WarningParamsByCode {
  'terrain-unavailable': { hasMsa: boolean }
  'route-data-unavailable': { airspace: boolean; obstacles: boolean }
  'aerodromes-unavailable': Record<string, never>
  'notams-unavailable': { reason: string }
  'aircraft-profile-missing': Record<string, never>
  'aircraft-assistant-review': { review: AssistantReview }
  'route-assistant-review': { review: AssistantReview }
  'water-beyond-glide': {
    sea: boolean; name: string | null; maxFromLandNm: number; atNm: number; beyondGlideNm: number; altFt: number; glideRangeNm: number
    glideRatio: number; glideAssumed: boolean; windFromDeg: number | null; windKts: number | null; driftNm: number | null
    neededFt: number | null
    /** Height to climb to (the needed height, when the aircraft can reach it), else null. */
    climbToFt: number | null
  }
  'airspace-equipment': { bandClass: string; bandType: string; name: string; lacks: 'transponder' | 'radio'; plannedFt: number; lowerFt: number; upperFt: number }
  'airspace-penetration': { bandClass: string; bandType: string; name: string; plannedFt: number; lowerFt: number; upperFt: number }
  'notam-airspace': { notam: NotamItem; alongNm: number; plannedFt: number }
  'below-msa': { fromName: string; toName: string; plannedFt: number; requiredFt: number; terrainClearanceFt: number; abeamNm: number; obstacleClearanceFt: number }
  'airfield-proximity': { label: string; lateralNm: number; distNm: number; plannedFt: number; elevationFt: number }
  'fuel-insufficient': { hop: { from: string; to: string } | null; requiredL: number; availableL: number }
  'fuel-tight': { hop: { from: string; to: string } | null; requiredL: number; availableL: number }
  'crosswind': { icao: string; role: string; windText: string; crosswindKt: number; runway: string; limitKt: number }
  'runway-short': {
    op: 'takeoff' | 'landing'; icao: string; role: string; requiredM: number; tempC: number | null; safety: number
    runway: { designator: string | null; lengthM: number; surface: string; paved: boolean }
  }
}

export type WarningCode = keyof WarningParamsByCode

/** A warning before it is worded. */
export type PreflightWarningItem = {
  [C in WarningCode]: {
    level: WarningLevel
    code: C
    params: WarningParamsByCode[C]
    fix?: WarningFix
    focusNm?: number
    legIndex?: number
  }
}[WarningCode]


function classLabel(cls: string, type: string): string {
  return /^[A-F]$/.test(cls)
    ? (type === 'CTR' ? `Class ${cls} CTR` : `Class ${cls}`)
    : cls === 'R' ? 'Restricted / danger area'
    : cls === 'TRA' ? 'TRA'
    : (type || cls)
}

const hopLabel = (hop: { from: string; to: string } | null) => (hop ? ` (${hop.from} → ${hop.to})` : '')

type Words = { title: string; detail: string }

const WORDS: { [C in WarningCode]: (p: WarningParamsByCode[C]) => Words } = {
  'terrain-unavailable': p => ({
    title: 'Terrain data unavailable',
    detail: p.hasMsa
      ? 'No elevation data for this route: the Minimum Safe Altitude check uses the terrain maximum grid (highest terrain per ~460 m cell, so conservative) and airspace limits given above ground (AGL) are checked at their raw height.'
      : 'No elevation data for this route: the Minimum Safe Altitude check was skipped and airspace limits given above ground (AGL) are checked at their raw height.',
  }),
  'route-data-unavailable': p => {
    const what = [p.airspace && 'airspace', p.obstacles && 'obstacles and landmarks'].filter(Boolean).join(' and ')
    return {
      title: `Route data unavailable: ${what}`,
      detail: `The ${what} file could not be loaded, so ${p.airspace ? 'airspace' : ''}${p.airspace && p.obstacles ? ' and ' : ''}${p.obstacles ? 'obstacle clearance' : ''} was not checked. Check the connection or download the area for offline use.`,
    }
  },
  'aerodromes-unavailable': () => ({ title: 'Aerodrome data unavailable', detail: 'Airfield proximity was not checked.' }),
  'notams-unavailable': p => ({ title: 'NOTAM restricted areas not checked', detail: p.reason }),
  'aircraft-profile-missing': () => ({
    title: 'Aircraft not found',
    detail: 'This route was planned with an aircraft that is not in your account or on this device: it was deleted, or made on another device and never reached the server (that device\'s aircraft list says so). Fuel and weight & balance calculations are unavailable until you pick an aircraft.',
  }),
  'aircraft-assistant-review': p => ({
    title: 'Check the aircraft profile',
    detail: `${assistantReviewLabel(p.review)} (assistant connection). Fuel, speeds and runway checks use these values: compare them with the POH, then open and save the aircraft.`,
  }),
  'route-assistant-review': p => ({
    title: 'Check the route',
    detail: `${assistantReviewLabel(p.review)} (assistant connection). Check every point, level and fuel stop on the map, then save the route.`,
  }),
  'water-beyond-glide': p => {
    const where = p.sea ? 'the sea' : p.name || 'a lake'
    const wind = p.windFromDeg != null && p.windKts != null
    return {
      title: `Beyond gliding distance from land over ${where}`,
      detail: `Up to ${p.maxFromLandNm} NM from land (at NM ${Math.round(p.atNm)}); about ${p.beyondGlideNm} NM of the route is beyond gliding distance. `
        + `From ${formatNumber(p.altFt)} ft you glide about ${p.glideRangeNm} NM in still air (glide ratio ${p.glideRatio}:1${p.glideAssumed ? ', assumed: set it in the aircraft profile' : ''})`
        + (wind ? `; the planned wind (${String(p.windFromDeg).padStart(3, '0')}° at ${p.windKts} kt) is included and moves the area you can reach about ${p.driftNm} NM downwind. ` : '. ')
        + `Reaching land from there needs ${p.neededFt === null ? 'more than a 60 NM glide' : `about ${formatNumber(p.neededFt)} ft`}${wind ? ' with that wind' : ''}. `
        + `${p.climbToFt !== null ? `Climb to about ${formatNumber(p.climbToFt)} ft, route` : 'Route'} closer to the shore, or carry life jackets for everyone on board (required for single-engine aircraft beyond gliding distance from land) and plan for ditching.`,
    }
  },
  'airspace-equipment': p => ({
    title: `${classLabel(p.bandClass, p.bandType)} ${p.name} needs ${p.lacks === 'radio' ? 'a radio' : 'a transponder'}`,
    detail: `Planned altitude ${formatNumber(p.plannedFt)} ft enters ${formatNumber(p.lowerFt)}–${formatNumber(p.upperFt)} ft. The aircraft profile has no ${p.lacks}: route around it, or above or below it.`,
  }),
  'airspace-penetration': p => ({
    title: `${classLabel(p.bandClass, p.bandType)} penetration — ${p.name}`,
    detail: `Planned altitude ${formatNumber(p.plannedFt)} ft enters ${formatNumber(p.lowerFt)}–${formatNumber(p.upperFt)} ft`,
  }),
  'notam-airspace': p => ({
    title: `${notamTitle(p.notam)} on route`,
    detail: `About ${Math.round(p.alongNm)} NM along the route, planned ${formatNumber(Math.round(p.plannedFt))} ft. ${notamSummary(p.notam)}`,
  }),
  'below-msa': p => ({
    title: `Leg ${p.fromName} → ${p.toName} below Minimum Safe Altitude`,
    detail: `Planned ${formatNumber(Math.round(p.plannedFt))} ft, minimum safe ${formatNumber(p.requiredFt)} ft (terrain + ${formatNumber(p.terrainClearanceFt)} ft within ${p.abeamNm} NM, obstacles + ${formatNumber(p.obstacleClearanceFt)} ft). Check Virtual Radar.`,
  }),
  'airfield-proximity': p => ({
    title: `Passes close to ${p.label}`,
    detail: `${p.lateralNm.toFixed(1)} NM from the track at ${Math.round(p.distNm)} NM, planned ${formatNumber(Math.round(p.plannedFt))} ft over a field at ${formatNumber(Math.round(p.elevationFt))} ft: expect circuit and arriving or departing traffic.`,
  }),
  'fuel-insufficient': p => ({
    title: `Insufficient fuel${hopLabel(p.hop)}`,
    detail: `Requires ${p.requiredL.toFixed(1)} L — available ${p.availableL.toFixed(1)} L`,
  }),
  'fuel-tight': p => ({
    title: `Tight fuel margin${hopLabel(p.hop)}`,
    detail: `Requires ${p.requiredL.toFixed(1)} L of ${p.availableL.toFixed(1)} L available`,
  }),
  'crosswind': p => ({
    title: `Crosswind at ${p.icao} (${p.role})`,
    detail: `Current wind ${p.windText}: ${p.crosswindKt} kt across runway ${p.runway}, the best runway, above the aircraft's ${p.limitKt} kt maximum demonstrated crosswind. Check the forecast for your arrival time.`,
  }),
  'runway-short': p => {
    const what = p.op === 'takeoff' ? 'take-off' : 'landing'
    const rwy = `${p.runway.designator ? `runway ${p.runway.designator}` : 'the longest runway'} (${p.runway.lengthM} m ${p.runway.paved ? 'paved' : (p.runway.surface.toLowerCase() || 'unknown surface')})`
    return {
      title: `Runway short for ${what} at ${p.icao} (${p.role})`,
      detail: `Needs about ${formatNumber(p.requiredM)} m: the aircraft's ${what} distance ${p.op === 'takeoff' ? 'over' : 'from'} 50 ft, scaled for elevation${p.tempC != null ? `, ${p.tempC} °C` : ''}, surface and a ${p.safety} safety factor. Best is ${rwy}. Check the POH for today's mass and conditions.`,
    }
  },
}

/** The one place a warning is worded: code + params -> the English title and detail (and everything else the item carries). */
export function formatPreflightWarning(item: PreflightWarningItem): PreflightWarning {
  const { params, ...rest } = item
  const words = (WORDS[item.code] as (p: unknown) => Words)(params)
  return { ...rest, params, ...words } as PreflightWarning
}
