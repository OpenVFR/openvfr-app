/**
 * Relevance filtering for NOTAM lists, applied on top of the distance
 * filters in notamRouteFilter.ts:
 *
 *  1. VFR only (default): drop NOTAMs whose Q-line traffic field says
 *     IFR-only ("I"). Unknown traffic (older API, missing field) is kept.
 *  2. FIR scope for NOTAMs with no usable position (mostly whole-FIR
 *     notices, Q-line radius 999): the distance filters can't judge them,
 *     so previously they were always kept -- which put, e.g., Lithuanian
 *     and Estonian country-wide notices into a Stockholm briefing. Now they
 *     are kept only when their FIR's country is one the given points
 *     (position / route / aerodrome) fall in. Unknown FIR is kept.
 *
 * Nothing is dropped silently: the result carries hidden counts so every
 * list can say what it isn't showing.
 */
import { EUROPEAN_REGIONS } from './regions'

/** ICAO location-indicator prefixes per supported region (ICAO Doc 7910). */
export const REGION_ICAO_PREFIXES: Record<string, string[]> = {
  se: ['ES'], no: ['EN'], fi: ['EF'], dk: ['EK'], is: ['BI'],
  ee: ['EE'], lv: ['EV'], lt: ['EY'],
  gb: ['EG'], ie: ['EI'],
  fr: ['LF'], be: ['EB'], nl: ['EH'], lu: ['EL'], de: ['ED', 'ET'], at: ['LO'], ch: ['LS'],
  pl: ['EP'], cz: ['LK'], sk: ['LZ'], hu: ['LH'],
  es: ['LE', 'GC'], pt: ['LP'], it: ['LI'], gr: ['LG'], cy: ['LC'], mt: ['LM'],
  ro: ['LR'], bg: ['LB'], hr: ['LD'], si: ['LJ'], rs: ['LY'], ba: ['LQ'], me: ['LY'], mk: ['LW'], al: ['LA'],
  ua: ['UK'], md: ['LU'], by: ['UM'],
}

export interface LatLng { lat: number; lng: number }

/**
 * ICAO prefixes of every region whose bounding box contains any of the
 * points. Bounding boxes overlap near borders, which over-includes
 * neighbouring countries there -- the safe direction for a briefing.
 * `extraIcaos` (e.g. the aerodrome being viewed, ICAO-named route
 * waypoints) add their own prefix directly.
 */
export function relevantFirPrefixes(points: LatLng[], extraIcaos: string[] = []): Set<string> {
  const out = new Set<string>()
  for (const r of EUROPEAN_REGIONS) {
    const [s, w, n, e] = r.bbox
    if (points.some(p => p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e)) {
      for (const pre of REGION_ICAO_PREFIXES[r.code] ?? []) out.add(pre)
    }
  }
  for (const icao of extraIcaos) {
    if (/^[A-Z]{4}$/.test(icao)) out.add(icao.slice(0, 2))
  }
  return out
}

interface RelevanceInput {
  id?: string
  text?: string
  lat: number | null
  lon: number | null
  polygon?: unknown
  affectedFir?: string | null
  icao?: { traffic: string | null } | null
}

export const isIfrOnly = (n: RelevanceInput): boolean => {
  const t = n.icao?.traffic?.toUpperCase()
  return !!t && !t.includes('V')
}

const hasPosition = (n: RelevanceInput): boolean => !!n.polygon || (n.lat !== null && n.lon !== null)

export interface RelevanceResult<T> {
  kept: T[]
  hiddenIfrOnly: number
  hiddenOtherFir: number
}

export function applyNotamRelevance<T extends RelevanceInput>(
  notams: T[],
  opts: { vfrOnly: boolean; firPrefixes: Set<string> },
): RelevanceResult<T> {
  let hiddenIfrOnly = 0
  let hiddenOtherFir = 0
  const kept: T[] = []
  // The same published notice often arrives once per filing location
  // (separate upstream records, identical number + text). Show it once --
  // not counted as "hidden", nothing is lost. Both number AND text must
  // match: authorities reuse numbers, so number alone is not identity.
  const seen = new Set<string>()
  for (const n of notams) {
    if (n.id !== undefined && n.text !== undefined) {
      const key = `${n.id}|${n.text}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    if (opts.vfrOnly && isIfrOnly(n)) { hiddenIfrOnly++; continue }
    if (!hasPosition(n) && n.affectedFir && opts.firPrefixes.size > 0
        && !opts.firPrefixes.has(n.affectedFir.slice(0, 2).toUpperCase())) {
      hiddenOtherFir++
      continue
    }
    kept.push(n)
  }
  return { kept, hiddenIfrOnly, hiddenOtherFir }
}

/** "3 IFR-only and 12 other-FIR NOTAMs hidden" -- or null when nothing hidden. */
export function relevanceHiddenNote(r: { hiddenIfrOnly: number; hiddenOtherFir: number }): string | null {
  const parts: string[] = []
  if (r.hiddenIfrOnly) parts.push(`${r.hiddenIfrOnly} IFR-only`)
  if (r.hiddenOtherFir) parts.push(`${r.hiddenOtherFir} for other FIRs`)
  if (!parts.length) return null
  const total = r.hiddenIfrOnly + r.hiddenOtherFir
  return `${total} NOTAM${total === 1 ? '' : 's'} hidden (${parts.join(', ')})`
}
