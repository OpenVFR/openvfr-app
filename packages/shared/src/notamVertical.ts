/**
 * notamVertical.ts -- vertical limits stated in NOTAM text, as typed values.
 *
 * Sources, in order of preference:
 *   1. items F) and G) (lower / upper limit), when both parse;
 *   2. "VERTICAL LIMITS: GND - 1800FT AMSL" style sections of item E, one
 *      section per area -- used only when the number of sections equals the
 *      number of areas drawn (a shared limit cannot be told apart from a
 *      missing one otherwise: refuse rather than guess);
 *   3. the Q-line flight levels ("000" / "999").
 *
 * A limit is `{ ref, ft }`: AGL (height above ground; GND/SFC = 0, ASFC),
 * AMSL (altitude on QNH) or FL (flight level, ft = level x 100). Metres are
 * converted with 3.28084 and rounded; thousands separators ("1.500FT") are
 * stripped. "UNL" is FL999 with `unlimited: true`.
 */
import { effectiveLimitFt } from './airspaceAltitude'

export type VerticalRef = 'AGL' | 'AMSL' | 'FL'

export interface VerticalLimit {
  ref: VerticalRef
  ft: number
  /** "UNL": no upper bound (ft is the FL999 placeholder). */
  unlimited?: true
}

/** One floor/ceiling pair. A NOTAM text may give a ceiling only. */
export interface VerticalPair {
  floor: VerticalLimit | null
  ceiling: VerticalLimit | null
}

export interface NotamVertical {
  source: 'fg' | 'text' | 'qline'
  /** One pair per drawn area (ring / circle); a single pair covers a single area. */
  pairs: VerticalPair[]
}

const M_TO_FT = 3.28084

const ATOM = new RegExp(
  String.raw`\b(SFC|GND|GROUND|SURFACE)\b` +                       // 1 surface
  String.raw`|\b(UNL|UNLIMITED)\b` +                                // 2 unlimited
  String.raw`|\bFL\s*(\d{2,3})\b` +                                 // 3 flight level
  String.raw`|(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(FT|METRES?|METERS?|M)?\b(?:\s*(AMSL|MSL|AGL|ASFC|AAL))?`, // 4 value, 5 unit, 6 ref
  'g',
)

interface Atom { limit: VerticalLimit | null; value?: number; unit?: 'FT' | 'M'; ref?: VerticalRef; at: number }

function atoms(s: string): Atom[] {
  const out: Atom[] = []
  for (const m of s.toUpperCase().matchAll(ATOM)) {
    const at = m.index!
    if (m[1]) out.push({ limit: { ref: 'AGL', ft: 0 }, at })
    else if (m[2]) out.push({ limit: { ref: 'FL', ft: 99900, unlimited: true }, at })
    else if (m[3]) out.push({ limit: { ref: 'FL', ft: Number(m[3]) * 100 }, at })
    else if (m[4]) {
      const digits = m[4]
      // "1.500" / "1,500" with FT or M and exactly three digits after the separator: thousands.
      const thousands = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits)
      const value = Number(thousands ? digits.replace(/[.,]/g, '') : digits.replace(',', '.'))
      const unit = m[5] ? (m[5] === 'FT' ? 'FT' : 'M') : undefined
      const r = m[6]
      const ref = r === 'AGL' || r === 'ASFC' || r === 'AAL' ? 'AGL' : r ? 'AMSL' : undefined
      out.push({ limit: null, value, unit, ref, at })
    }
  }
  // "400-700FT AMSL": a value without unit/reference takes them from the next one.
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i]!, b = out[i + 1]!
    if (a.value !== undefined) {
      a.unit ??= b.unit
      a.ref ??= b.ref
    }
  }
  for (const a of out) {
    if (a.value === undefined) continue
    if (a.unit && a.ref) {
      a.limit = { ref: a.ref, ft: Math.round(a.unit === 'M' ? a.value * M_TO_FT : a.value) }
    }
  }
  return out
}

/** One limit ("GND", "SFC", "FL095", "2000FT AMSL", "600 M AMSL", "1.500FT ASFC", "UNL"), or null. */
export function parseVerticalLimit(s: string | null | undefined): VerticalLimit | null {
  if (!s) return null
  const a = atoms(s)
  return a.length === 1 ? a[0]!.limit : null
}

/** "GND - 1800FT AMSL" -> floor/ceiling; a lone value is a ceiling. null when unreadable. */
export function parseVerticalSection(s: string): VerticalPair | null {
  const a = atoms(s)
  if (a.length < 1 || a.length > 2 || a.some(x => !x.limit)) return null
  if (a.length === 1) return { floor: null, ceiling: a[0]!.limit }
  let [lo, hi] = [a[0]!.limit!, a[1]!.limit!]
  // "3000FT AMSL / 1000FT AMSL": same reference, written upper first.
  if (lo.ref === hi.ref && lo.ft > hi.ft) [lo, hi] = [hi, lo]
  return { floor: lo, ceiling: hi }
}

const SECTION = /\b(?:VERTICAL\s+LIMITS?|VERT\s+LIMITS?)\s*:?\s*/g
// A section ends at a sentence end or at the next "LABEL:" of the text.
const SECTION_END = /\.(?=\s|$)|\b[A-Z]{3,}\s*:/

/** Pairs from every "VERTICAL LIMITS: ..." section of item E, in order; unreadable sections give null. */
export function verticalSectionsFromText(text: string): (VerticalPair | null)[] {
  const t = text.replace(/[\r\n]+/g, ' ').toUpperCase()
  const out: (VerticalPair | null)[] = []
  for (const m of t.matchAll(SECTION)) {
    const rest = t.slice(m.index! + m[0].length)
    const end = rest.search(SECTION_END)
    out.push(parseVerticalSection(end >= 0 ? rest.slice(0, end) : rest))
  }
  return out
}

/** Q-line lower/upper FL ("000", "999"): 000 is the surface, 999 has no upper bound. */
function fromQLine(lowerFl: string | null | undefined, upperFl: string | null | undefined): VerticalPair | null {
  if (!/^\d{3}$/.test(lowerFl ?? '') || !/^\d{3}$/.test(upperFl ?? '')) return null
  const lo = Number(lowerFl), hi = Number(upperFl)
  return {
    floor: lo === 0 ? { ref: 'AGL', ft: 0 } : { ref: 'FL', ft: lo * 100 },
    ceiling: hi >= 999 ? { ref: 'FL', ft: 99900, unlimited: true } : { ref: 'FL', ft: hi * 100 },
  }
}

export interface NotamVerticalInput {
  text: string
  icao?: { lowerLimit?: string | null; upperLimit?: string | null; lowerFl?: string | null; upperFl?: string | null } | null
}

/**
 * Vertical limits of a NOTAM for `areaCount` drawn areas (rings / circles; 1
 * for a point or a Q-line circle). Sections in the text must match the area
 * count exactly, otherwise they are ignored and the next source is tried.
 */
export function notamVertical(n: NotamVerticalInput, areaCount: number): NotamVertical | null {
  const count = Math.max(1, areaCount)
  const lo = parseVerticalLimit(n.icao?.lowerLimit), hi = parseVerticalLimit(n.icao?.upperLimit)
  if (lo && hi) return { source: 'fg', pairs: Array.from({ length: count }, () => ({ floor: lo, ceiling: hi })) }

  const sections = verticalSectionsFromText(n.text)
  if (sections.length === count && sections.every((s): s is VerticalPair => !!s)) {
    return { source: 'text', pairs: sections }
  }

  const q = fromQLine(n.icao?.lowerFl, n.icao?.upperFl)
  return q ? { source: 'qline', pairs: Array.from({ length: count }, () => q) } : null
}

/** "GND", "FL095", "2000 FT AMSL", "1500 FT AGL", "UNL". */
export function formatVerticalLimit(l: VerticalLimit): string {
  if (l.unlimited) return 'UNL'
  if (l.ref === 'FL') return `FL${String(Math.round(l.ft / 100)).padStart(3, '0')}`
  if (l.ref === 'AGL' && l.ft === 0) return 'GND'
  return `${l.ft} FT ${l.ref}`
}

/** "GND – 2000 FT AMSL"; several distinct pairs are joined with " / ". null when none. */
export function formatNotamVertical(v: NotamVertical | null | undefined): string | null {
  if (!v || v.pairs.length === 0) return null
  const parts = v.pairs.map(p => `${p.floor ? formatVerticalLimit(p.floor) : '…'} – ${p.ceiling ? formatVerticalLimit(p.ceiling) : '…'}`)
  return [...new Set(parts)].join(' / ')
}

/**
 * A limit as an altitude (ft, comparable with own QNH altitude). AGL limits
 * are lifted by `terrainFt` when known; same rule as charted airspace.
 */
export function verticalLimitAltitudeFt(l: VerticalLimit, terrainFt?: number | null): number {
  return effectiveLimitFt(l.ref === 'AGL' ? 'AGL' : l.ref === 'FL' ? 'FL' : 'AMSL', l.ft, terrainFt)
}
