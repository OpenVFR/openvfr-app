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
  /** Item 19 emergency radio: UHF, VHF (121.5 MHz) and ELT (ELBA). */
  emergencyRadio: readonly ('U' | 'V' | 'E')[]
  /** Item 19 survival equipment: polar, desert, maritime, jungle. */
  survival: readonly ('P' | 'D' | 'M' | 'J')[]
  /** Item 19 life jackets: with light, fluorescein, UHF, VHF. */
  jackets: readonly ('L' | 'F' | 'U' | 'V')[]
  /** Item 19 dinghies: number, total capacity, covered, colour. */
  dinghies: { count: number; capacity: number; covered: boolean; colour: string }
  remarks: string
  pilotName: string
  /** Phone number the ATS can reach the pilot on. */
  pilotPhone: string
}

export const EMPTY_ANSWERS: Omit<FlightAnswers, 'eobt'> = {
  rules: 'V', levelMode: 'VFR', type: 'G', alternate: undefined, personsOnBoard: 1, emergencyRadio: [], survival: [], jackets: [],
  dinghies: { count: 0, capacity: 0, covered: false, colour: '' }, remarks: '', pilotName: '', pilotPhone: '',
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0')
const ICAO_AD = /^[A-Z]{4}$/

/** Dinghy colours: LFV allows B, G, R, W, Y as abbreviations; other colours in plain text. */
const COLOUR_LETTER: Record<string, string> = { BLUE: 'B', GREEN: 'G', RED: 'R', WHITE: 'W', YELLOW: 'Y' }
export function dinghyColour(v: string): string {
  return v.split(/[\s,/]+/).filter(Boolean).map(w => COLOUR_LETTER[aftnText(w)] ?? aftnText(w)).join(' ')
}

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

/** Aerodromes by their ICAO code, everything else (navaids, reporting points, places) as coordinates. */
function fplPoint(w: RouteWaypoint): string {
  const name = (w.name ?? '').trim().toUpperCase()
  return ICAO_AD.test(name) ? name : fplCoordinate(w.lat, w.lng)
}

const hhmm = (mins: number) => `${pad(Math.floor(mins / 60) % 100)}${pad(Math.round(mins % 60))}`

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
 * punctuation / ( ) - + . , ' : = ?, accents removed, anything else a space.
 */
export function aftnText(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 /()+.,'=?:-]/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface FplMessage {
  /** The message in parentheses, one line per item group. */
  text: string
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
  /** The time now (default: the clock), for the departure time window. */
  nowMs?: number
}): FplMessage {
  const { waypoints, legOverrides, aircraft, flight } = input
  const ac = fplAircraftItems(aircraft)
  const problems = [...ac.missing]
  if (waypoints.length < 2) {
    return { text: '', supplementary: [], problems: ['Plan a route first.', ...problems], aircraft: ac }
  }
  const first = waypoints[0]!, last = waypoints[waypoints.length - 1]!
  const depName = (first.name ?? '').trim().toUpperCase(), destName = (last.name ?? '').trim().toUpperCase()
  const depOk = ICAO_AD.test(depName), destOk = ICAO_AD.test(destName)

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
    return `${fplPoint(w)}${changed ? `/${legSpeed(leg)}${legLevel(leg)}` : ''}`
  })
  const speed = legSpeed(0), level = legLevel(0)
  // DCT joins the points, except between two points given as coordinates (ICAO Annex 2, Appendix 2, item 15 c).
  const isCoord = (p: string) => /^\d{4}[NS]\d{5}[EW]/.test(p)
  if (mid.length === 0) problems.push('the route needs at least one point between departure and destination (LFV requires a significant point in item 15)')
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
  if (aftnText(flight.remarks)) other.push(`RMK/${aftnText(flight.remarks).replace(/[()]/g, ' ')}`)
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
  if (!(flight.personsOnBoard >= 1)) problems.push('persons on board')

  const text = [
    `(FPL-${ac.identification || 'XXXXX'}-${flight.rules}${flight.type}`,
    `-${ac.type}/${ac.wake}-${ac.equipment}/${ac.surveillance}`,
    `-${depOk ? depName : 'ZZZZ'}${eobt}`,
    `-${speed}${level} ${route}`,
    `-${destOk ? destName : 'ZZZZ'}${eet}${alt2}`,
    `-${other.join(' ')})`,
  ].join('\n')

  // Endurance: usable fuel at the cruise burn.
  const endurance = aircraft.fuelBurnLhr > 0 && aircraft.maxFuelL > 0 ? hhmm((aircraft.maxFuelL / aircraft.fuelBurnLhr) * 60) : ''
  if (!endurance) problems.push('endurance (needs usable fuel and fuel burn in the profile)')
  else if (plan.enrouteMins > 0 && (aircraft.maxFuelL / aircraft.fuelBurnLhr) * 60 < eetMins) problems.push('the endurance is less than the flight time')
  const d = flight.dinghies
  const supplementary = [
    `19 Endurance: ${endurance ? `E/${endurance}` : '-'}`,
    `Persons on board: P/${pad(flight.personsOnBoard, 3)}`,
    `Emergency radio: ${flight.emergencyRadio.length ? 'R/' + flight.emergencyRadio.join('') : 'none'}`,
    `Survival equipment: ${flight.survival.length ? 'S/' + flight.survival.join('') : 'none'}`,
    `Life jackets: ${flight.jackets.length ? 'J/' + ['L', 'F', 'U', 'V'].filter(j => (flight.jackets as readonly string[]).includes(j)).join('') : 'none'}`,
    `Dinghies: ${d.count > 0 ? `D/${pad(d.count)} ${pad(d.capacity, 3)} ${d.covered ? 'C' : ''} ${dinghyColour(d.colour)}`.replace(/\s+/g, ' ').trim() : 'none'}`,
    `Aircraft colour and markings: ${aftnText(ac.colour) ? `A/${aftnText(ac.colour)}` : '-'}`,
    `Remarks: ${aftnText(flight.remarks) ? `N/${aftnText(flight.remarks)}` : '-'}`,
    `Pilot in command: C/${aftnText(flight.pilotName) || '-'}${flight.pilotPhone.trim() ? `  Tel ${flight.pilotPhone.trim()}` : ''}`,
  ]
  return { text, supplementary, problems, aircraft: ac }
}
