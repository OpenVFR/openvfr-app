/**
 * An ICAO flight plan (items 7 to 19) for a VFR flight, built from the route,
 * the aircraft profile and the per-flight answers. Output is text to check and
 * file; nothing is sent from here.
 *
 *   (FPL-SEABC-VG
 *   -C172/L-V/C
 *   -ESSB1030
 *   -N0105A035 DCT 5921N01756E DCT
 *   -ESGG0145 ESSA
 *   -REG/SEABC DOF/261112)
 *
 * Item 19 (supplementary information) is not part of the message but is given
 * with the filing; it is built as a separate block of lines.
 */
import type { RouteWaypoint } from './routeCalc'
import { iasToTas } from './airspeed'
import { computeFuelPlan } from './fuelCalc'
import { fplAircraftItems, type FplAircraftItems } from './icaoFlightPlan'
import type { AircraftProfileDocType, LegOverride } from './types'

export type FlightRules = 'V' | 'I' | 'Y' | 'Z'
export type FlightType = 'S' | 'N' | 'G' | 'M' | 'X'

export const FLIGHT_RULES_LABELS: Record<FlightRules, string> = {
  V: 'VFR', I: 'IFR', Y: 'IFR first, then VFR', Z: 'VFR first, then IFR',
}
export const FLIGHT_TYPE_LABELS: Record<FlightType, string> = {
  G: 'General aviation (private and commercial work, not taxi)',
  N: 'Non-scheduled air transport (also air taxi)',
  S: 'Scheduled air service',
  M: 'Military, police or customs',
  X: 'Other (explain in remarks)',
}

/** What is asked once per flight. */
export type LevelMode = 'VFR' | 'planned'

export interface FlightAnswers {
  rules: FlightRules
  /** Item 15 level: the word VFR, or the planned levels (with the changes along the route). */
  levelMode: LevelMode
  type: FlightType
  /** Estimated off-block time, UTC. */
  eobt: Date
  /** First alternate aerodrome (ICAO), if any. */
  alternate?: string
  personsOnBoard: number
  /** Persons on board not known yet: item 19 says TBN (to be notified); tell the ATS before taxiing. */
  personsUnknown?: boolean
  /** Item 19 emergency radio: UHF, VHF (121.5 MHz) and ELT (ELBA). */
  emergencyRadio: readonly ('U' | 'V' | 'E')[]
  /** Item 19 survival equipment: polar, desert, maritime, jungle. */
  survival: readonly ('P' | 'D' | 'M' | 'J')[]
  /** Item 19 life jackets: with light, fluorescein, UHF, VHF. */
  jackets: readonly ('L' | 'F' | 'U' | 'V')[]
  /** Life jackets carried without light, fluorescein or radio: written as the remark JACKETS. */
  jacketsPlain?: boolean
  /** Item 19 dinghies (life rafts): number, total capacity in persons, with canopy, colour. */
  dinghies: { count: number; capacity: number; covered: boolean; colour: string }
  remarks: string
  pilotName: string
  /** Phone number the ATS can reach the pilot on. */
  pilotPhone: string
}

/** Option tables for the per-flight questions, shared by the web dialog and the mobile sheet. */
export const FPL_SURVIVAL: readonly (readonly [string, string])[] = [['P', 'Polar'], ['D', 'Desert'], ['M', 'Maritime'], ['J', 'Jungle']]
export const FPL_JACKETS: readonly (readonly [string, string])[] = [['L', 'Light'], ['F', 'Fluorescein'], ['U', 'UHF radio'], ['V', 'VHF radio']]
export const FPL_RADIOS: readonly (readonly [string, string])[] = [['U', 'UHF'], ['V', 'VHF 121.5'], ['E', 'ELT']]

/** What stays the same from flight to flight and is remembered on the device. */
export const FPL_DEFAULT_KEYS = ['pilotName', 'pilotPhone', 'emergencyRadio', 'survival', 'jackets', 'dinghies'] as const
export type FplDefaults = Pick<FlightAnswers, (typeof FPL_DEFAULT_KEYS)[number]>

/** Add the value to the list, or take it out when it is there. */
export function toggleItem<T extends string>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
}

/** Off-block time to start from: the next five-minute mark at least half an hour ahead. */
export function defaultEobt(nowMs: number = Date.now()): Date {
  return new Date(Math.ceil((nowMs + 30 * 60_000) / 300_000) * 300_000)
}

/** The aircraft fields the export form can change, to save back to the profile. */
export function fplAircraftPatch(a: Pick<AircraftProfileDocType, 'registration' | 'icaoType' | 'colour' | 'transponder' | 'equipment' | 'hasRadio'>) {
  return { registration: a.registration, icaoType: a.icaoType, colour: a.colour, transponder: a.transponder, equipment: a.equipment, hasRadio: a.hasRadio }
}

export const EMPTY_ANSWERS: Omit<FlightAnswers, 'eobt'> = {
  rules: 'V', levelMode: 'VFR', type: 'G', alternate: undefined, personsOnBoard: 1, emergencyRadio: [], survival: [], jackets: [],
  dinghies: { count: 0, capacity: 0, covered: false, colour: '' }, remarks: '', pilotName: '', pilotPhone: '',
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0')
const ICAO_AD = /^[A-Z]{4}$/

/** A route point as ICAO degrees and minutes: 5921N01756E. */
export function fplCoordinate(lat: number, lng: number): string {
  const dm = (v: number, w: number) => {
    const a = Math.abs(v)
    let d = Math.floor(a), m = Math.round((a - d) * 60)
    if (m === 60) { d += 1; m = 0 }
    return `${pad(d, w)}${pad(m)}`
  }
  return `${dm(lat, 2)}${lat >= 0 ? 'N' : 'S'}${dm(lng, 3)}${lng >= 0 ? 'E' : 'W'}`
}

/** ICAO codes of the aerodromes in the aerodrome data, from the features of an aerodrome GeoJSON file. */
export function aerodromeCodes(fc: { features?: readonly { properties?: Record<string, unknown> | null }[] } | null | undefined): Set<string> | undefined {
  if (!fc?.features) return undefined
  return new Set(fc.features.map(f => String(f.properties?.['icao'] ?? '').toUpperCase()).filter(c => ICAO_AD.test(c)))
}

/** Four digits hours and minutes from a number of minutes (rounded once, so 119.7 is 0200, never 0160). */
const hhmm = (mins: number) => { const m = Math.round(mins); return `${pad(Math.floor(m / 60) % 100)}${pad(m % 60)}` }

/**
 * Item 15 level for a planned altitude: A045 = 4,500 ft, in hundreds of feet. The app plans levels in
 * feet on QNH and has no transition altitude per country, so an altitude is never converted to a
 * flight level here (a flight level is a pressure altitude); the check list tells the pilot to do that.
 */
export function fplLevel(altFt: number): string {
  return `A${pad(Math.round(altFt / 100), 3)}`
}

/** At or above this altitude a level is normally filed as a flight level; the real transition altitude is in the national AIP (ENR 1.7). */
export const FLIGHT_LEVEL_CHECK_FT = 5000

/**
 * Text the aeronautical network accepts: upper case letters and digits, space and the
 * punctuation / - + . , ' : = ?, accents removed, anything else a space. Brackets are
 * left out on purpose: a bracket inside a field would end the message early.
 */
export function aftnText(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 /+.,'=?:-]/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface FplMessage {
  /** The message in parentheses, one line per item group. */
  text: string
  /** The message with item 19 inside it, for filing forms that take a pasted message. */
  importText: string
  /** Item 19 as labelled lines for the filing form. */
  supplementary: string[]
  /** What is missing or needs a look before it can be filed. */
  problems: string[]
  aircraft: FplAircraftItems
}

export function buildFpl(input: {
  waypoints: readonly RouteWaypoint[]
  legOverrides: readonly LegOverride[]
  aircraft: AircraftProfileDocType
  legWinds?: ({ dirDeg: number; speedKts: number } | null)[]
  flight: FlightAnswers
  /**
   * ICAO codes of the known aerodromes. A route point is written as an aerodrome code only when it is in
   * this set; any other point (a place, a reporting point, an aerodrome without a code) goes in as
   * coordinates, or ZZZZ with DEP/ DEST/. Without it, any four-letter name is taken for an aerodrome
   * and the check list says so.
   */
  aerodromes?: ReadonlySet<string>
  /** The time now (default: the clock), for the departure time window. */
  nowMs?: number
}): FplMessage {
  const { waypoints, legOverrides, aircraft, flight } = input
  const ac = fplAircraftItems(aircraft)
  const problems = [...ac.missing]
  if (waypoints.length < 2) {
    return { text: '', importText: '', supplementary: [], problems: ['Plan a route first.', ...problems], aircraft: ac }
  }
  const first = waypoints[0]!, last = waypoints[waypoints.length - 1]!
  const depName = (first.name ?? '').trim().toUpperCase(), destName = (last.name ?? '').trim().toUpperCase()
  const isAd = (n: string) => ICAO_AD.test(n) && (input.aerodromes ? input.aerodromes.has(n) : true)
  const depOk = isAd(depName), destOk = isAd(destName)
  if (!input.aerodromes && (depOk || destOk)) problems.push('the aerodrome data is not loaded, so the aerodrome codes in the plan were not verified: check them')

  // Cruising speed (true airspeed, knots) and level of each leg; the first leg's go in the speed/level field.
  const nLegs = waypoints.length - 1
  const legAlt = (i: number) => legOverrides[i]?.altFt ?? (aircraft.cruiseAltFt || 0)
  const legIas = (i: number) => legOverrides[i]?.speedKts ?? aircraft.cruiseIas
  if (!(legIas(0) > 0)) problems.push('cruise speed (set it in the aircraft profile)')
  const legSpeed = (i: number) => `N${pad(Math.round(iasToTas(legIas(i) > 0 ? legIas(i) : 0, legAlt(i))), 4)}`
  const legLevel = (i: number) => (flight.levelMode === 'VFR' || legAlt(i) <= 0 ? 'VFR' : fplLevel(legAlt(i)))
  if (flight.levelMode === 'planned' && Array.from({ length: nLegs }, (_, i) => legAlt(i)).some(a => a >= FLIGHT_LEVEL_CHECK_FT)) {
    problems.push('a planned level is at or above 5,000 ft: above the transition altitude (see the national AIP, ENR 1.7) a level is a flight level (F, on the standard pressure setting), so change it by hand; the plan gives altitudes on QNH')
  }

  // Route: the points between the ends joined by DCT. Where speed or level changes, the new values follow the point.
  const mid = waypoints.slice(1, -1).map((w, k) => {
    const leg = k + 1
    const changed = legSpeed(leg) !== legSpeed(leg - 1) || legLevel(leg) !== legLevel(leg - 1)
    return `${isAd((w.name ?? '').trim().toUpperCase()) ? (w.name ?? '').trim().toUpperCase() : fplCoordinate(w.lat, w.lng)}${changed ? `/${legSpeed(leg)}${legLevel(leg)}` : ''}`
  })
  const speed = legSpeed(0), level = legLevel(0)
  // DCT joins the points, except between two points given as coordinates (ICAO Annex 2, Appendix 2, item 15 c).
  const isCoord = (p: string) => /^\d{4}[NS]\d{5}[EW]/.test(p)
  const tokens = ['DCT']
  mid.forEach((p, k) => {
    if (k > 0 && !(isCoord(p) && isCoord(mid[k - 1]!))) tokens.push('DCT')
    tokens.push(p)
  })
  if (mid.length && !isCoord(mid[mid.length - 1]!)) tokens.push('DCT')
  const route = tokens.join(' ')

  // Estimated elapsed time, with the leg winds when known.
  const plan = computeFuelPlan([...waypoints], [...legOverrides], aircraft, input.legWinds)
  const eetMins = Math.ceil(plan.enrouteMins)
  const eet = plan.enrouteMins > 0 ? hhmm(eetMins) : '0000'
  if (!(plan.enrouteMins > 0)) problems.push('flight time (needs a cruise speed)')

  const eobt = `${pad(flight.eobt.getUTCHours())}${pad(flight.eobt.getUTCMinutes())}`
  const dof = `${pad(flight.eobt.getUTCFullYear() % 100)}${pad(flight.eobt.getUTCMonth() + 1)}${pad(flight.eobt.getUTCDate())}`

  const alt2 = flight.alternate && ICAO_AD.test(flight.alternate.toUpperCase()) ? ` ${flight.alternate.toUpperCase()}` : ''
  if (flight.alternate && !alt2) problems.push('the alternate must be an ICAO aerodrome code')
  if (alt2 && destOk && flight.alternate!.toUpperCase() === destName) problems.push('the alternate cannot be the same aerodrome as the destination')

  // Item 18 keywords in the order the standard lists them.
  const other = [...ac.other]
  if (!depOk) other.push(`DEP/${fplCoordinate(first.lat, first.lng)}`)
  if (!destOk) other.push(`DEST/${fplCoordinate(last.lat, last.lng)}`)
  other.push(`DOF/${dof}`)
  const ITEM18_ORDER = ['STS', 'PBN', 'NAV', 'COM', 'DAT', 'SUR', 'DEP', 'DEST', 'DOF', 'REG', 'EET', 'SEL', 'TYP', 'CODE', 'DLE', 'OPR', 'ORGN', 'PER', 'ALTN', 'RALT', 'TALT', 'RIF', 'RVR', 'RFP', 'RMK']
  const rank = (s: string) => { const i = ITEM18_ORDER.indexOf(s.split('/')[0]!); return i < 0 ? 99 : i }
  if (flight.type === 'X' && !flight.remarks.trim()) problems.push('type of flight X needs an explanation in remarks')
  if (aftnText(flight.remarks)) other.push(`RMK/${aftnText(flight.remarks)}`)
  other.sort((a, b) => rank(a) - rank(b))

  if (!ac.identification) problems.push('aircraft registration')
  if (!aftnText(flight.pilotName)) problems.push('pilot in command (name)')
  const phone = flight.pilotPhone.trim()
  if (!phone) problems.push('a phone number the ATS can reach you on')
  else if (!/^\+\d{6,}/.test(phone.replace(/[\s-]/g, ''))) problems.push('the phone number must start with + and the country code')
  const nowMs = input.nowMs ?? Date.now()
  const ahead = flight.eobt.getTime() - nowMs
  if (Number.isNaN(ahead)) problems.push('off-block time')
  else if (ahead < 5 * 60_000 || ahead > 5 * 86_400_000) problems.push('the off-block time must be more than 5 minutes ahead and less than 5 days ahead')
  if (flight.dinghies.count > 0 && (!(flight.dinghies.capacity > 0) || !aftnText(flight.dinghies.colour))) problems.push('dinghies need a capacity and a colour')
  if (!flight.personsUnknown && !(flight.personsOnBoard >= 1)) problems.push('persons on board (or say they are not known yet)')

  const text = [
    `(FPL-${ac.identification || 'XXXXX'}-${flight.rules}${flight.type}`,
    `-${ac.type}/${ac.wake}-${ac.equipment}/${ac.surveillance}`,
    `-${depOk ? depName : 'ZZZZ'}${eobt}`,
    `-${speed}${level} ${route}`,
    `-${destOk ? destName : 'ZZZZ'}${eet}${alt2}`,
    `-${other.join(' ')})`,
  ].join('\n')

  // Endurance: the fuel in the profile (maxFuelL is the usable fuel) at the cruise burn, rounded down so it is never overstated.
  const enduranceMins = aircraft.fuelBurnLhr > 0 && aircraft.maxFuelL > 0 ? (aircraft.maxFuelL / aircraft.fuelBurnLhr) * 60 : 0
  const endurance = enduranceMins > 0 ? hhmm(Math.floor(enduranceMins)) : ''
  if (!endurance) problems.push('endurance (needs usable fuel and fuel burn in the profile)')
  else if (plan.enrouteMins > 0 && enduranceMins < eetMins) problems.push('the endurance is less than the flight time')

  // Item 19, built once; the labelled lines and the inline text both come from these fields.
  const d = flight.dinghies
  const jacketLetters = FPL_JACKETS.map(([c]) => c).filter(c => (flight.jackets as readonly string[]).includes(c)).join('')
  const remarks19 = [flight.jacketsPlain && flight.jackets.length === 0 ? 'JACKETS' : '', aftnText(flight.remarks)].filter(Boolean).join(' ')
  const phone19 = aftnText(flight.pilotPhone)
  const f19 = {
    E: endurance ? `E/${endurance}` : '',
    P: `P/${flight.personsUnknown ? 'TBN' : pad(flight.personsOnBoard, 3)}`,
    R: flight.emergencyRadio.length ? `R/${flight.emergencyRadio.join('')}` : '',
    S: flight.survival.length ? `S/${flight.survival.join('')}` : '',
    J: flight.jackets.length ? `J/${jacketLetters}` : '',
    D: d.count > 0 ? ['D/' + pad(d.count), pad(d.capacity, 3), d.covered ? 'C' : '', aftnText(d.colour)].filter(Boolean).join(' ') : '',
    A: aftnText(ac.colour) ? `A/${aftnText(ac.colour)}` : '',
    N: remarks19 ? `N/${remarks19}` : '',
    C: `C/${aftnText(flight.pilotName)}`,
  }
  const supplementary = [
    `19 Endurance: ${f19.E || '-'}`,
    `Persons on board: ${f19.P}`,
    `Emergency radio: ${f19.R || 'none'}`,
    `Survival equipment: ${f19.S || 'none'}`,
    `Life jackets: ${f19.J || 'none'}`,
    `Life rafts: ${f19.D || 'none'}`,
    `Aircraft colour and markings: ${f19.A || '-'}`,
    `Remarks: ${f19.N || '-'}`,
    `Pilot in command: ${f19.C === 'C/' ? 'C/-' : f19.C}${phone19 ? `  Tel ${phone19}` : ''}`,
  ]

  // For import forms that take a pasted message with item 19 inside it: item 19 before the closing bracket.
  const line1 = [f19.E, f19.P, f19.R, f19.S, f19.J, f19.D].filter(Boolean).join(' ')
  const rest = [f19.A, f19.N, `${f19.C}${phone19 ? ` ${phone19}` : ''}`].filter(Boolean)
  const importText = `${text.slice(0, -1)}\n-${line1}\n${rest.join('\n')})`
  return { text, importText, supplementary, problems, aircraft: ac }
}
