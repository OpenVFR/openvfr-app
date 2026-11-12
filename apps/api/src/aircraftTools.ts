/**
 * Aircraft profiles written by an AI assistant (MCP create_aircraft /
 * update_aircraft): turn the assistant's values into a profile, check them
 * with the same rules as the POH import, and say what was assumed.
 *
 * Nothing the assistant sends is trusted blindly: unknown keys are dropped,
 * numbers must be finite and inside hard limits, POH values get the import's
 * range and consistency checks (warnings), and the saved profile carries an
 * `assistantReview` mark so the app shows "check before use" until the pilot
 * saves it there.
 */
import type { AircraftCategory, AircraftProfileDocType, TransponderMode } from '@open-vfr/shared/types'
import { POH_FIELDS, parsePohReply, parseFuelGrades, type PohField } from '@open-vfr/shared/pohImport'

export const CATEGORIES: readonly AircraftCategory[] = ['SEP', 'MEP', 'MICRO', 'GYRO', 'HELI', 'TMG', 'GLIDER']

/** Numeric profile fields an assistant may set, with hard limits (outside = refused). */
export const NUMERIC_LIMITS = {
  cruiseAltFt: [0, 30000], cruiseIas: [0, 400], fuelBurnLhr: [0, 1000], maxFuelL: [0, 5000],
  unusableFuelL: [0, 500], taxiFuelL: [0, 200], landingFuelL: [0, 1000],
  holdingMin: [0, 180], diversionMin: [0, 180], finalReserveMin: [0, 120], contingencyPct: [0, 50],
  serviceCeilingFt: [0, 40000], rocSlFpm: [0, 6000], rocCeilingFpm: [0, 2000],
  climbIas: [0, 300], climbFuelLhr: [0, 1000], climbFuelCeilingLhr: [0, 1000],
  descentFpm: [0, 4000], descentIas: [0, 400], descentFuelLhr: [0, 1000],
  bestGlideIas: [0, 250], glideRatio: [0, 80], takeoffSpeedKts: [0, 200], maxCrosswindKts: [0, 60],
  takeoffDist50ftM: [0, 5000], landingDist50ftM: [0, 5000],
  vs0Kts: [0, 150], vs1Kts: [0, 160], vxKts: [0, 250], vfeKts: [0, 300], vaKts: [0, 350], vnoKts: [0, 400], vneKts: [0, 450],
  minRunwayM: [0, 5000],
} as const

export type NumericField = keyof typeof NUMERIC_LIMITS

export interface AircraftInput {
  name?: string
  registration?: string
  icaoType?: string
  category?: AircraftCategory
  fuelTypes?: string[]
  hardRunwayOnly?: boolean
  transponder?: TransponderMode
  hasRadio?: boolean
  /** POH page per field: shown to the pilot in the answer, so each value can be checked where it came from. */
  pages?: Record<string, string | number>
  values?: Partial<Record<NumericField, number>>
}

export class AircraftInputError extends Error {}

export interface AircraftBuild {
  doc: AircraftProfileDocType
  /** Fields set or changed. */
  changed: string[]
  /** Values that look wrong (still saved, marked for review). */
  warnings: string[]
  /** Defaults the profile got because the input had no value. */
  defaults: string[]
  /** POH page the assistant gave per field (only for fields that were set), as text. */
  pages: Record<string, string>
}

const RESERVE_DEFAULTS: Partial<Record<NumericField, number>> = { holdingMin: 30, diversionMin: 30, contingencyPct: 10 }

function blankProfile(id: string): AircraftProfileDocType {
  return {
    id, name: '', registration: '', icaoType: '', category: 'SEP',
    cruiseAltFt: 0, cruiseIas: 0, fuelBurnLhr: 0, maxFuelL: 0, taxiFuelL: 0, landingFuelL: 0,
    holdingMin: 0, contingencyPct: 0, serviceCeilingFt: 0, rocSlFpm: 0, rocCeilingFpm: 0,
    climbIas: 0, climbFuelLhr: 0, descentFpm: 0, descentIas: 0, descentFuelLhr: 0,
    bestGlideIas: 0, glideRatio: 0, updatedAt: 0,
  }
}

/**
 * Build the profile to save. `existing` = update (only the given fields change),
 * none = create. `by` names the assistant for the review mark.
 */
export function buildAircraft(input: AircraftInput, opts: { existing?: AircraftProfileDocType; newId: string; by: string; now: number }): AircraftBuild {
  const creating = !opts.existing
  const doc: AircraftProfileDocType = { ...(opts.existing ?? blankProfile(opts.newId)) }
  const changed: string[] = []
  const defaults: string[] = []
  const set = <K extends keyof AircraftProfileDocType>(k: K, v: AircraftProfileDocType[K]) => {
    if (JSON.stringify(doc[k]) !== JSON.stringify(v)) { doc[k] = v; changed.push(String(k)) }
  }

  // ── Identity ──────────────────────────────────────────────────────────
  if (input.registration !== undefined) {
    const reg = input.registration.trim().toUpperCase().slice(0, 20)
    if (!reg) throw new AircraftInputError('The registration cannot be empty.')
    set('registration', reg)
  }
  if (input.name !== undefined) set('name', input.name.trim().slice(0, 80))
  if (input.icaoType !== undefined) set('icaoType', input.icaoType.trim().toUpperCase().slice(0, 4))
  if (input.category !== undefined) set('category', input.category)
  if (creating && !doc.registration) throw new AircraftInputError('A new aircraft needs a registration.')
  if (creating && !doc.name) doc.name = [doc.icaoType, doc.registration].filter(Boolean).join(' ')

  // ── Numbers ───────────────────────────────────────────────────────────
  const values = input.values ?? {}
  for (const [k, v] of Object.entries(values) as [NumericField, number][]) {
    if (!(k in NUMERIC_LIMITS)) continue
    const [lo, hi] = NUMERIC_LIMITS[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      throw new AircraftInputError(`${k} must be a number from ${lo} to ${hi}.`)
    }
    set(k as keyof AircraftProfileDocType, Math.round(v * 100) / 100 as never)
  }
  if (creating) {
    for (const [k, v] of Object.entries(RESERVE_DEFAULTS) as [NumericField, number][]) {
      if (values[k] === undefined) { (doc as Record<string, unknown>)[k] = v; defaults.push(`${k} ${v}`) }
    }
  }
  if (input.fuelTypes !== undefined) set('fuelTypes', parseFuelGrades(input.fuelTypes))
  if (input.hardRunwayOnly !== undefined) set('hardRunwayOnly', input.hardRunwayOnly)
  if (input.transponder !== undefined) set('transponder', input.transponder)
  if (input.hasRadio !== undefined) set('hasRadio', input.hasRadio)

  // A powered aircraft is no use for planning without speed, burn and fuel.
  if (doc.category !== 'GLIDER' && (doc.cruiseIas <= 0 || doc.fuelBurnLhr <= 0 || doc.maxFuelL <= 0)) {
    throw new AircraftInputError('A powered aircraft needs cruiseIas, fuelBurnLhr and maxFuelL (usable fuel) above 0.')
  }

  // ── The POH import's checks, on the resulting profile ─────────────────
  const pohValues: Record<string, unknown> = {}
  for (const f of POH_FIELDS) {
    const v = doc[f as keyof AircraftProfileDocType]
    if (typeof v === 'number' ? v > 0 : typeof v === 'string' ? v !== '' : false) pohValues[f] = v
  }
  const warnings: string[] = []
  if (Object.keys(pohValues).length > 0) {
    const checked = parsePohReply(JSON.stringify(pohValues))
    for (const [f, why] of Object.entries(checked.warnings) as [PohField, string][]) warnings.push(`${f}: ${why}`)
  }

  // An unreviewed profile stays 'created', and unreviewed changes add up until the pilot saves it in the app.
  const prev = opts.existing?.assistantReview
  const thisChange = changed
  doc.assistantReview = {
    by: opts.by, at: opts.now,
    change: creating || prev?.change === 'created' ? 'created' : [...new Set([...(Array.isArray(prev?.change) ? prev.change : []), ...thisChange])],
  }
  doc.updatedAt = opts.now
  const pages: Record<string, string> = {}
  for (const [f, pg] of Object.entries(input.pages ?? {})) {
    if (changed.includes(f) || f in values) pages[f.slice(0, 40)] = String(pg).slice(0, 20)
  }
  return { doc, changed, warnings, defaults, pages }
}
