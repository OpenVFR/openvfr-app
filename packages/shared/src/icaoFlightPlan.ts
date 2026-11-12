/**
 * ICAO flight plan items that come from the aircraft profile (items 7, 9, 10,
 * and the aircraft parts of 18 and 19), and what is still missing for them.
 * The per-flight items (flight rules, type of flight, EOBT, persons on board,
 * survival equipment, pilot) are not here: they belong to the filing.
 *
 * Letters follow the ICAO flight plan form (Doc 4444). Only the equipment a
 * light aircraft can have is offered; the others are never produced.
 */
import type { AdsbCode, AircraftProfileDocType, WakeCategory } from './types'

/** Item 9: a type designator is 2 to 4 characters starting with a letter (ICAO Doc 8643). */
const TYPE_RE = /^[A-Z][A-Z0-9]{1,3}$/

export function normaliseIcaoType(v: string): string {
  return v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function isIcaoType(v: string | undefined): boolean {
  return !!v && TYPE_RE.test(v)
}

/** Equipment letters of item 10a a light aircraft can carry, in alphabetical order (the order they are listed and written in). */
export const EQUIPMENT_LETTERS: readonly { code: string; label: string }[] = [
  { code: 'B', label: 'LPV approaches (SBAS)' },
  { code: 'D', label: 'DME' },
  { code: 'F', label: 'ADF' },
  { code: 'G', label: 'GNSS (GPS)' },
  { code: 'H', label: 'HF radio' },
  { code: 'L', label: 'ILS' },
  { code: 'O', label: 'VOR' },
  { code: 'R', label: 'PBN approved' },
  { code: 'T', label: 'TACAN' },
  { code: 'U', label: 'UHF radio' },
  { code: 'V', label: 'VHF radio' },
  { code: 'W', label: 'RVSM approved' },
  { code: 'Y', label: 'VHF with 8.33 kHz spacing' },
  { code: 'Z', label: 'Other equipment (say which in remarks)' },
]

const ORDER = new Map(EQUIPMENT_LETTERS.map((e, i) => [e.code, i]))

/** What the equipment letters mean in the one place that needs spelling out. */
export const STANDARD_EQUIPMENT_NOTE =
  'Standard (S) means VHF without 8.33 kHz, ADF, VOR and ILS, as in Swedish airspace. Most light aircraft lack ADF or ILS: then choose the equipment you have.'

/**
 * Clean a set of letters for item 10a: known letters only, in form order, no
 * repeats. `N` (none) and `S` (standard) stand alone and win over single letters
 * (N over S). Empty = nothing set.
 */
export function normaliseEquipment(letters: readonly string[] | undefined): string[] {
  const up = [...new Set((letters ?? []).map(l => l.trim().toUpperCase()).filter(Boolean))]
  if (up.includes('N')) return ['N']
  if (up.includes('S')) return ['S']
  return up.filter(l => ORDER.has(l)).sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)
}

/**
 * Whether the equipment letters include a VHF radio: S (standard) and V or Y say yes; N, or letters
 * without V and Y, say no; nothing set is unknown (undefined).
 */
export function vhfFromEquipment(equipment: readonly string[] | undefined): boolean | undefined {
  const l = normaliseEquipment(equipment)
  if (l.length === 0) return undefined
  return l[0] === 'S' || l.includes('V') || l.includes('Y')
}

/** VHF radio of a profile: from its equipment letters when set, else the older radio flag (undefined = unknown). */
export function hasVhfRadio(p: { equipment?: readonly string[]; hasRadio?: boolean }): boolean | undefined {
  return vhfFromEquipment(p.equipment) ?? p.hasRadio
}

export const WAKE_LABELS: Record<WakeCategory, string> = {
  L: 'Light (7,000 kg or less)',
  M: 'Medium (7,000 to 136,000 kg)',
  H: 'Heavy (136,000 kg or more)',
  J: 'Super (A380-800)',
}

export const ADSB_LABELS: Record<AdsbCode, string> = {
  B1: '1090 MHz ADS-B out',
  B2: '1090 MHz ADS-B out and in',
  U1: 'UAT ADS-B out',
  U2: 'UAT ADS-B out and in',
}

export interface FplAircraftItems {
  /** Item 7. */
  identification: string
  /** Item 9: type designator ('ZZZZ' when the profile has none). */
  type: string
  /** Item 9: wake turbulence category. */
  wake: WakeCategory
  /** Item 10a: equipment letters joined ('N' when none is set at all). */
  equipment: string
  /** Item 10b: transponder letter, then ADS-B. */
  surveillance: string
  /** Item 18 fragments the aircraft needs (TYP/ for ZZZZ, REG/, CODE/, NAV/GPS when GNSS is carried). */
  other: string[]
  /** Item 19: colour and markings (A/). */
  colour: string
  /** What the profile lacks for a flight plan, in plain words. */
  missing: string[]
}

const XPDR: Record<string, string> = { none: 'N', A: 'A', C: 'C', S: 'S' }

export function fplAircraftItems(p: Pick<AircraftProfileDocType, 'registration' | 'icaoType' | 'wakeCategory' | 'equipment' | 'hasRadio' | 'transponder' | 'adsb' | 'colour' | 'modeSHex'>): FplAircraftItems {
  const missing: string[] = []
  const reg = p.registration.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!reg) missing.push('registration (item 7)')

  const typed = normaliseIcaoType(p.icaoType ?? '')
  const typeOk = isIcaoType(typed)
  if (!typeOk) missing.push('ICAO type designator (item 9): 2 to 4 characters from ICAO Doc 8643, or ZZZZ with the type in remarks')

  // Equipment: the set letters, else VHF from the old radio flag, else not set.
  let letters = normaliseEquipment(p.equipment)
  if (letters.length === 0 && p.hasRadio === true) letters = ['V']
  if (letters.length === 0 && p.hasRadio === false) letters = ['N']
  if (letters.length === 0) missing.push('radio and navigation equipment (item 10a)')
  const equipment = letters.length ? letters.join('') : 'N'

  let sur = p.transponder ? XPDR[p.transponder] ?? 'N' : ''
  if (!p.transponder) missing.push('transponder (item 10b)')
  if (!sur) sur = 'N'
  if (p.adsb) sur = sur === 'N' ? p.adsb : `${sur}${p.adsb}`

  const colour = (p.colour ?? '').trim()
  if (!colour) missing.push('colour and markings (item 19)')

  const other: string[] = []
  if (!typeOk && typed) other.push(`TYP/${typed}`)
  if (reg) other.push(`REG/${reg}`)
  const hex = (p.modeSHex ?? '').trim().toUpperCase()
  if (/^[0-9A-F]{6}$/.test(hex)) other.push(`CODE/${hex}`)
  // G needs the GNSS type after NAV/ (GPS is what a light aircraft has); Z needs the pilot to say what it is.
  if (letters.includes('G')) other.push('NAV/GPS')
  if (letters.includes('Z')) missing.push('equipment Z (other): say what it is in remarks, as COM/, NAV/ or DAT/')

  return {
    identification: reg,
    type: typeOk ? typed : 'ZZZZ',
    wake: p.wakeCategory ?? 'L',
    equipment, surveillance: sur, other, colour: colour.toUpperCase(), missing,
  }
}
