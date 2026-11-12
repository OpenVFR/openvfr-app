/**
 * POH (Pilot's Operating Handbook) import through the pilot's own AI
 * assistant: no server, no model key.
 *
 *   1. The app gives the pilot a prompt (`buildPohPrompt`).
 *   2. The pilot attaches the POH PDF in any chat assistant and sends the
 *      prompt. The assistant answers with one JSON object.
 *   3. The pilot pastes the answer back; `parsePohReply` finds the JSON,
 *      normalises the numbers and flags values that look implausible.
 *
 * The answer comes from a model the app does not control, so it is treated
 * as untrusted input: only known keys are read, numbers are parsed, and
 * anything out of range is flagged for the pilot to check. Nothing is saved
 * until the pilot saves the form.
 */
import type { FuelCode } from './types'
import { FUEL_CODES } from './fuelTypes'

/** Aircraft profile fields a POH can fill. Values are form strings. */
export const POH_FIELDS = [
  'name', 'icaoType', 'cruiseAltFt', 'cruiseIas', 'fuelBurnLhr', 'maxFuelL',
  'unusableFuelL', 'taxiFuelL', 'landingFuelL', 'serviceCeilingFt', 'rocSlFpm',
  'rocCeilingFpm', 'climbIas', 'climbFuelLhr', 'climbFuelCeilingLhr',
  'descentFpm', 'descentIas', 'descentFuelLhr',
  'bestGlideIas', 'glideRatio', 'takeoffSpeedKts', 'maxCrosswindKts',
  'takeoffDist50ftM', 'landingDist50ftM',
  'vs0Kts', 'vs1Kts', 'vxKts', 'vfeKts', 'vaKts', 'vnoKts', 'vneKts',
] as const

export type PohField = typeof POH_FIELDS[number]

const TEXT_FIELDS: ReadonlySet<PohField> = new Set(['name', 'icaoType'])

const FIELD_GUIDE: Record<PohField, string> = {
  name:             'aircraft model name (string, e.g. "Cessna 172S Skyhawk")',
  icaoType:         'ICAO type designator (string, e.g. "C172", "GYRO", "GLID")',
  cruiseAltFt:      'typical cruise / normal operating altitude in feet. Convert from metres (×3.281).',
  cruiseIas:        'typical cruise IAS in knots (normal or recommended cruise). Convert from km/h (×0.5400) or mph (×0.8690).',
  fuelBurnLhr:      'cruise fuel consumption in litres per hour. Convert from US gal/h (×3.785) or UK gal/h (×4.546).',
  maxFuelL:         'total USABLE fuel in litres for the STANDARD tank (total minus unusable; not optional or auxiliary tanks).',
  taxiFuelL:        'fuel for engine start, warm-up and taxi in litres.',
  landingFuelL:     'fixed reserve that must REMAIN IN THE TANK AT LANDING, in litres (final reserve, landing reserve). A minimum fuel for take-off or a pre-flight minimum is NOT this value: omit the field if only that is given.',
  serviceCeilingFt: 'service ceiling or maximum operating altitude in feet. Convert from metres (×3.281).',
  rocSlFpm:         'best rate of climb at sea level in ft/min. Convert from m/s (×197) or m/min (×3.281).',
  rocCeilingFpm:    'rate of climb at the service ceiling in ft/min. Use the value the document gives, or the rate by which it defines the service ceiling (often 100 ft/min); omit it otherwise.',
  climbIas:         'best rate of climb speed (Vy) in knots IAS.',
  climbFuelLhr:     'fuel consumption during climb at sea level in litres per hour.',
  climbFuelCeilingLhr: 'fuel consumption during climb near the service ceiling in litres per hour; omit it if the document gives only one climb fuel flow.',
  unusableFuelL:    'unusable fuel in litres for the standard tank(s). Convert from US gal (×3.785) or UK gal (×4.546).',
  descentFpm:       'typical descent rate in ft/min, as a positive number.',
  descentIas:       'typical descent IAS in knots.',
  descentFuelLhr:   'fuel consumption during descent in litres per hour.',
  bestGlideIas:     'best glide speed in knots IAS (gliders, motor gliders, gyroplanes).',
  glideRatio:       'best glide ratio as a number, e.g. 30 for 30:1 (gliders, motor gliders, gyroplanes).',
  takeoffSpeedKts:  'rotation (VR), lift-off (VLOF) or normal take-off speed in knots.',
  maxCrosswindKts:  'maximum demonstrated crosswind velocity in knots. Convert from km/h (×0.5400) or m/s (×1.944).',
  takeoffDist50ftM: 'take-off distance to clear a 50 ft (15 m) obstacle in metres, at maximum take-off mass, sea level, standard temperature (15 °C), paved dry runway, no wind. Convert from feet (×0.3048).',
  landingDist50ftM: 'landing distance from 50 ft (15 m) in metres, at maximum landing mass, sea level, standard temperature, paved dry runway, no wind. Convert from feet (×0.3048).',
  vs0Kts:           'Vs0, stall speed in landing configuration (full flaps), knots IAS.',
  vs1Kts:           'Vs1, stall speed clean (flaps up), knots IAS.',
  vxKts:            'Vx, best angle of climb speed, knots IAS.',
  vfeKts:           'Vfe, maximum flap extended speed (full flaps), knots IAS.',
  vaKts:            'Va, manoeuvring speed at maximum mass, knots IAS.',
  vnoKts:           'Vno, maximum structural cruising speed, knots IAS.',
  vneKts:           'Vne, never exceed speed, knots IAS.',
}

/** The prompt the pilot sends to their assistant together with the POH PDF. */
/** Why and how to pick the assistant for a POH: shown next to the prompt in the web and mobile apps. */
export const POH_MODEL_ADVICE =
  'For the best result use a model with deep thinking (extended reasoning) that can read PDF files: POH tables, graphs and diagrams are scanned images, and a fast model reads them less reliably. Check every value against the POH.'

/** The alternative to copy and paste: an assistant connected to OpenVFR creates the profile itself. */
export const POH_CONNECT_ADVICE =
  'Or connect your AI assistant to OpenVFR (account panel, AI assistants) and ask it to add your aircraft from the attached POH: it fills in and checks the profile directly, and you review it in the app.'

export function buildPohPrompt(): string {
  const lines = POH_FIELDS.map(k => `- "${k}": ${FIELD_GUIDE[k]}`)
  return [
    'I attached the Pilot\'s Operating Handbook (POH / AFM) of my aircraft. Read the whole document, including tables, charts, limitations and appendices, and fill in an aircraft profile for my flight planning app.',
    '',
    'Take your time: think through every table, graph and diagram step by step (they may be scanned images), and check the units and conversions before you answer.',
    '',
    'Rules:',
    '- Only give a value that the document states. Never guess or use typical values for the type. Leave a field out if you cannot find it.',
    '- Use the units below and convert where the document uses other units.',
    '- Numbers only (no units in the value).',
    '- For every value, give the page number where you found it in "pages".',
    '',
    'Fields:',
    ...lines,
    `- "fuelTypes": array of the fuel grades the engine is approved for, using only these codes: ${FUEL_CODES.map(c => `"${c}"`).join(', ')} (MOGAS = motor gasoline / unleaded car fuel; JETA1 also for diesel engines). Put the grade the document recommends first.`,
    '',
    'Answer with ONLY one JSON object in this shape, nothing else:',
    '{"name": "...", "cruiseIas": 105, "fuelTypes": ["AVGAS100LL"], "pages": {"name": 1, "cruiseIas": 34}}',
  ].join('\n')
}

export interface PohReply {
  /** Values found, as form strings. */
  values: Partial<Record<PohField, string>>
  /** POH page per field, where the assistant gave one. */
  pages: Partial<Record<PohField, string>>
  /** Fields the reply did not contain. */
  missing: PohField[]
  /** Fields whose value looks wrong, with a short reason for the pilot. */
  warnings: Partial<Record<PohField, string>>
  /** Approved fuel grades; empty when the reply named none we know. */
  fuelTypes: FuelCode[]
}

/**
 * Map the fuel grade names a model or a POH uses ("100LL", "Jet A-1",
 * "UL 91", "unleaded EN 228") to our codes. Unknown names are dropped.
 */
export function parseFuelGrades(v: unknown): FuelCode[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;/]/) : []
  const out = new Set<FuelCode>()   // insertion order = order named
  for (const item of items) {
    if (typeof item !== 'string') continue
    const s = item.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!s) continue
    if (s.includes('UL91') || s === 'AVGASUL91') out.add('AVGAS_UL91')
    else if (s.includes('100')) out.add('AVGAS100LL')
    else if (s.includes('JET') || s === 'A1' || s.includes('DIESEL')) out.add('JETA1')
    else if (s.includes('MOGAS') || s.includes('EN228') || s.includes('UNLEADED') || s.includes('RON') || s.includes('OCT')) out.add('MOGAS')
    else if (s === 'AVGAS') out.add('AVGAS100LL')
  }
  // In the order the reply names them (a POH often lists the recommended grade first).
  return [...out]
}

/** Thrown when a pasted reply has no usable JSON object. The message is for the pilot. */
export class PohReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PohReplyError'
  }
}

/** Longest reply accepted; a real answer is well under 2 kB. */
const MAX_REPLY_CHARS = 50_000

/**
 * Find the first balanced `{...}` in `text`, ignoring braces inside JSON
 * strings. Tolerates markdown code fences and prose around the object.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Parse a number the way a model might write it: 105, "105", "105 kt", "1,5" (decimal comma), "13,500" (thousands separator). */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  // A comma followed by exactly three digits is a thousands separator ("13,500"), otherwise a decimal comma ("1,5").
  const plain = /^-?\d{1,3}(,\d{3})+(?!\d)/.test(t) ? t.replace(/,/g, '') : t.replace(/(\d),(\d)/, '$1.$2')
  const m = plain.match(/^-?\d+(\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** Plausible range per numeric field, wide enough for micro to twin. */
const RANGES: Partial<Record<PohField, [number, number]>> = {
  cruiseAltFt:      [500, 30000],
  cruiseIas:        [20, 350],
  fuelBurnLhr:      [1, 500],
  maxFuelL:         [5, 3000],
  taxiFuelL:        [0, 100],
  landingFuelL:     [0, 500],
  serviceCeilingFt: [1000, 35000],
  rocSlFpm:         [100, 4000],
  rocCeilingFpm:    [0, 1000],
  climbIas:         [20, 250],
  climbFuelLhr:     [1, 600],
  climbFuelCeilingLhr: [1, 600],
  unusableFuelL:    [0, 200],
  descentFpm:       [100, 3000],
  descentIas:       [20, 350],
  descentFuelLhr:   [0, 500],
  bestGlideIas:     [15, 200],
  glideRatio:       [2, 80],
  takeoffSpeedKts:  [10, 150],
  maxCrosswindKts:  [3, 45],
  takeoffDist50ftM: [50, 3000],
  landingDist50ftM: [50, 3000],
  vs0Kts:           [15, 120],
  vs1Kts:           [15, 130],
  vxKts:            [20, 200],
  vfeKts:           [30, 250],
  vaKts:            [40, 300],
  vnoKts:           [40, 350],
  vneKts:           [50, 400],
}

/** Parse the assistant's answer. Throws PohReplyError when it has no usable JSON. */
export function parsePohReply(text: string): PohReply {
  if (text.length > MAX_REPLY_CHARS) {
    throw new PohReplyError('The pasted text is too long. Paste only the assistant\'s answer.')
  }
  const json = extractJsonObject(text)
  if (!json) {
    throw new PohReplyError('No data found in the pasted text. Paste the whole answer, including the part between { and }.')
  }
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    throw new PohReplyError('The pasted answer is not complete or not valid JSON. Ask the assistant to answer with the JSON object only, then paste it again.')
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new PohReplyError('The pasted answer is not an aircraft profile.')
  }
  const rec = obj as Record<string, unknown>
  const rawPages = rec['pages'] !== null && typeof rec['pages'] === 'object' && !Array.isArray(rec['pages'])
    ? rec['pages'] as Record<string, unknown>
    : {}

  const values: PohReply['values'] = {}
  const pages: PohReply['pages'] = {}
  const warnings: PohReply['warnings'] = {}
  const missing: PohField[] = []
  const nums: Partial<Record<PohField, number>> = {}

  for (const key of POH_FIELDS) {
    const raw = rec[key]
    if (raw === undefined || raw === null || raw === '') { missing.push(key); continue }

    if (TEXT_FIELDS.has(key)) {
      if (typeof raw !== 'string' && typeof raw !== 'number') { missing.push(key); continue }
      const s = String(raw).trim().slice(0, key === 'icaoType' ? 4 : 80)
      if (!s) { missing.push(key); continue }
      values[key] = key === 'icaoType' ? s.toUpperCase() : s
    } else {
      let n = toNumber(raw)
      if (n === null) { missing.push(key); continue }
      if (key === 'descentFpm' && n < 0) n = -n
      if (n < 0) { warnings[key] = 'Negative value'; n = -n }
      nums[key] = n
      values[key] = fmt(n)
      const range = RANGES[key]
      if (range && (n < range[0] || n > range[1])) {
        warnings[key] = `Unusual value (expected ${range[0]} to ${range[1]})`
      }
    }

    const page = rawPages[key]
    if (typeof page === 'number' || (typeof page === 'string' && page.trim() !== '')) {
      pages[key] = String(page).trim().slice(0, 20)
    }
  }

  // Cross-checks between fields: each flags the field most likely wrong.
  const flag = (k: PohField, why: string) => { if (!warnings[k]) warnings[k] = why }
  const {
    maxFuelL, taxiFuelL, landingFuelL, cruiseAltFt, serviceCeilingFt, climbIas, cruiseIas, takeoffSpeedKts,
    rocSlFpm, rocCeilingFpm, fuelBurnLhr, descentFuelLhr,
    vs0Kts, vs1Kts, vxKts, vfeKts, vaKts, vnoKts, vneKts,
  } = nums
  if (maxFuelL !== undefined && taxiFuelL !== undefined && taxiFuelL >= maxFuelL) flag('taxiFuelL', 'Not less than the usable fuel')
  if (maxFuelL !== undefined && landingFuelL !== undefined && landingFuelL >= maxFuelL) flag('landingFuelL', 'Not less than the usable fuel')
  if (cruiseAltFt !== undefined && serviceCeilingFt !== undefined && cruiseAltFt > serviceCeilingFt) flag('cruiseAltFt', 'Above the service ceiling')
  if (climbIas !== undefined && cruiseIas !== undefined && climbIas > cruiseIas) flag('climbIas', 'Faster than cruise speed')
  if (takeoffSpeedKts !== undefined && cruiseIas !== undefined && takeoffSpeedKts >= cruiseIas) flag('takeoffSpeedKts', 'Not slower than cruise speed')
  if (rocSlFpm !== undefined && rocCeilingFpm !== undefined && rocCeilingFpm >= rocSlFpm) flag('rocCeilingFpm', 'Not below the sea-level climb rate')
  if (fuelBurnLhr !== undefined && descentFuelLhr !== undefined && descentFuelLhr > fuelBurnLhr) flag('descentFuelLhr', 'Higher than cruise fuel burn')
  // V-speed order: Vs0 <= Vs1 < Vfe <= Vno < Vne, Va < Vne, Vx <= Vy.
  if (vs0Kts !== undefined && vs1Kts !== undefined && vs0Kts > vs1Kts) flag('vs0Kts', 'Higher than Vs1')
  if (vs1Kts !== undefined && vfeKts !== undefined && vfeKts <= vs1Kts) flag('vfeKts', 'Not above Vs1')
  if (vfeKts !== undefined && vnoKts !== undefined && vfeKts > vnoKts) flag('vfeKts', 'Above Vno')
  if (vnoKts !== undefined && vneKts !== undefined && vnoKts >= vneKts) flag('vnoKts', 'Not below Vne')
  if (vaKts !== undefined && vneKts !== undefined && vaKts >= vneKts) flag('vaKts', 'Not below Vne')
  if (vxKts !== undefined && climbIas !== undefined && vxKts > climbIas) flag('vxKts', 'Above Vy (climb IAS)')
  if (vs1Kts !== undefined && cruiseIas !== undefined && vs1Kts >= cruiseIas) flag('vs1Kts', 'Not below cruise speed')

  const fuelTypes = parseFuelGrades(rec['fuelTypes'])

  if (Object.keys(values).length === 0 && fuelTypes.length === 0) {
    throw new PohReplyError('The answer has none of the aircraft fields. Check that the assistant read the POH, then try again.')
  }
  return { values, pages, missing, warnings, fuelTypes }
}
