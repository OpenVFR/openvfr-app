/**
 * MCP tools for the pilot's aircraft profiles: read one, create, update
 * (never delete). Values are checked by aircraftTools.ts; every profile an
 * assistant makes or changes is marked for the pilot's review in the app.
 */
import * as z from 'zod'
import type { AircraftProfileDocType } from '@open-vfr/shared/types'
import { quote, QUOTE_NOTE } from './untrusted'
import { buildAircraft, CATEGORIES, NUMERIC_LIMITS, type AircraftInput, type NumericField } from './aircraftTools'
import { aircraftLabel, fail, text, type Ctx, type Text } from './mcpContext'

const FIELD_HELP: Partial<Record<NumericField, string>> = {
  cruiseAltFt: 'typical cruise altitude, ft', cruiseIas: 'cruise IAS, kt', fuelBurnLhr: 'cruise fuel burn, L/h',
  maxFuelL: 'USABLE fuel of the standard tanks, L', unusableFuelL: 'unusable fuel, L', taxiFuelL: 'start/taxi/take-off fuel, L',
  landingFuelL: 'fixed fuel to keep at landing, L', holdingMin: 'holding reserve, min', diversionMin: 'diversion reserve, min',
  finalReserveMin: 'final reserve, min', contingencyPct: 'contingency, % of trip fuel',
  serviceCeilingFt: 'service ceiling, ft', rocSlFpm: 'best rate of climb at sea level, ft/min', rocCeilingFpm: 'rate of climb at the service ceiling, ft/min',
  climbIas: 'Vy / climb IAS, kt', climbFuelLhr: 'climb fuel burn at sea level, L/h', climbFuelCeilingLhr: 'climb fuel burn near the ceiling, L/h',
  descentFpm: 'descent rate, ft/min', descentIas: 'descent IAS, kt', descentFuelLhr: 'descent fuel burn, L/h',
  bestGlideIas: 'best glide IAS, kt', glideRatio: 'glide ratio, e.g. 30 for 30:1', takeoffSpeedKts: 'rotation / lift-off speed, kt',
  maxCrosswindKts: 'maximum demonstrated crosswind, kt', takeoffDist50ftM: 'take-off distance over 50 ft, m (max mass, sea level, ISA, paved)',
  landingDist50ftM: 'landing distance from 50 ft, m (same conditions)', vs0Kts: 'Vs0, kt', vs1Kts: 'Vs1, kt', vxKts: 'Vx, kt',
  vfeKts: 'Vfe, kt', vaKts: 'Va, kt', vnoKts: 'Vno, kt', vneKts: 'Vne, kt', minRunwayM: 'shortest runway the pilot accepts, m',
}

/** Input fields shared by create_aircraft and update_aircraft: units are fixed, convert before calling. */
const aircraftFields = {
  name: z.string().max(80).optional().describe('Profile name, e.g. "Cessna 182R"'),
  icaoType: z.string().max(4).optional().describe('ICAO type designator, e.g. C182'),
  category: z.enum(CATEGORIES as [string, ...string[]]).optional().describe('SEP, MEP, MICRO, GYRO, HELI, TMG or GLIDER'),
  fuelTypes: z.array(z.string().max(30)).max(4).optional().describe('Approved fuels, preferred first: AVGAS100LL, AVGAS_UL91, MOGAS, JETA1'),
  hardRunwayOnly: z.boolean().optional(),
  transponder: z.enum(['none', 'A', 'C', 'S']).optional(),
  hasRadio: z.boolean().optional(),
  pages: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('POH page per field name, so the pilot can check'),
  ...Object.fromEntries((Object.keys(NUMERIC_LIMITS) as NumericField[]).map(k => {
    const [lo, hi] = NUMERIC_LIMITS[k]
    return [k, z.number().min(lo).max(hi).optional().describe(FIELD_HELP[k] ?? k)]
  })),
}

function toInput(a: Record<string, unknown>): AircraftInput {
  const values: Partial<Record<NumericField, number>> = {}
  for (const k of Object.keys(NUMERIC_LIMITS) as NumericField[]) if (typeof a[k] === 'number') values[k] = a[k] as number
  return {
    name: a['name'] as string | undefined, registration: a['registration'] as string | undefined,
    icaoType: a['icaoType'] as string | undefined, category: a['category'] as AircraftInput['category'],
    fuelTypes: a['fuelTypes'] as string[] | undefined, hardRunwayOnly: a['hardRunwayOnly'] as boolean | undefined,
    transponder: a['transponder'] as AircraftInput['transponder'], hasRadio: a['hasRadio'] as boolean | undefined,
    pages: a['pages'] as AircraftInput['pages'], values,
  }
}

function profileText(a: AircraftProfileDocType): string {
  const skip = new Set(['id', 'updatedAt', 'assistantReview'])
  return Object.entries(a).filter(([k, v]) => !skip.has(k) && v !== undefined && v !== '' && v !== 0)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v, 80) : Array.isArray(v) ? v.join(', ') : String(v)}`).join('\n')
}

export function registerAircraftTools(c: Ctx): void {
  const { deps, caller } = c
  const user = { id: caller.userId }

  c.tool('get_aircraft', {
    description: "All fields of one of the pilot's aircraft profiles (by registration or name).",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ aircraft: z.string().min(1).max(80) }),
  }, async ({ aircraft }) => {
    if (!c.canRoutes) return c.noRoutes()
    const ac = await c.resolveAircraft(aircraft)
    if ('error' in ac) return ac.error
    const a = ac.profile
    if (!a) return fail(`No aircraft ${quote(aircraft, 40)}. Use list_aircraft.`)
    const review = a.assistantReview ? `\n(Check before use: ${a.assistantReview.change === 'created' ? 'added' : 'changed'} by ${quote(a.assistantReview.by, 60)}, not yet reviewed in the app.)` : ''
    return text(`${aircraftLabel(a)}\n${profileText(a)}${review}\n${QUOTE_NOTE}`)
  })

  const saveBuild = async (built: ReturnType<typeof buildAircraft>, verb: 'created' | 'updated', seenUpdatedAt?: number): Promise<Text> => {
    await c.save.aircraft(built.doc, seenUpdatedAt)
    console.log(`[mcp] aircraft ${verb} user=${caller.userId} client=${caller.clientId} id=${built.doc.id} fields=${built.changed.join(',')}`)
    const lines = [`${verb === 'created' ? 'Added' : 'Updated'} ${aircraftLabel(built.doc)} in OpenVFR${verb === 'updated' ? `: ${built.changed.join(', ') || 'nothing changed'}` : ''}.`]
    if (built.warnings.length) lines.push(`Values that look wrong, check them against the POH: ${built.warnings.join('; ')}.`)
    if (built.defaults.length) lines.push(`Defaults used (no value given): ${built.defaults.join(', ')}.`)
    const pages = Object.entries(built.pages)
    if (pages.length) lines.push(`POH pages the assistant gave, to check the values: ${pages.map(([f, pg]) => `${quote(f, 40)} p. ${quote(pg, 20)}`).join('; ')}.`)
    lines.push('The app shows it as "check before use" until the pilot opens and saves it there. It appears on their devices at the next sync.')
    return text(lines.join('\n'))
  }

  c.tool('create_aircraft', {
    description: 'Add an aircraft profile for the pilot, e.g. from an attached POH/AFM. Read its tables, graphs and diagrams carefully (they may be scanned images) before answering. Give only values the document states, converted to the units in each field description, with the POH page per field in `pages`. Needs a registration; powered aircraft need cruiseIas, fuelBurnLhr and maxFuelL (USABLE fuel). The values are checked and the profile is marked for the pilot to review in the app.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: z.object({ registration: z.string().min(2).max(20).describe('Registration, e.g. SE-ABC'), ...aircraftFields }),
  }, async (args) => {
    if (!c.canAircraftWrite) return c.noAircraftWrite()
    if (!c.canRoutes) return c.noRoutes()
    const existing = (await deps.briefings.userAircraft(user)).find(a => a.registration.toUpperCase() === String(args.registration).trim().toUpperCase())
    if (existing) return fail(`${quote(existing.registration, 20)} already exists. Use update_aircraft to change it.`)
    const built = buildAircraft(toInput(args as Record<string, unknown>), { newId: crypto.randomUUID(), by: await deps.clientName(caller.clientId), now: Date.now() })
    return saveBuild(built, 'created')
  })

  c.tool('update_aircraft', {
    description: "Change fields of one of the pilot's aircraft profiles (by registration or name). Only the given fields change; units as in each field description. Cannot delete a profile.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: z.object({ aircraft: z.string().min(1).max(80).describe('Registration or name of the profile to change'), registration: z.string().min(2).max(20).optional().describe('New registration'), ...aircraftFields }),
  }, async (args) => {
    if (!c.canAircraftWrite) return c.noAircraftWrite()
    if (!c.canRoutes) return c.noRoutes()
    const ac = await c.resolveAircraft(String(args.aircraft))
    if ('error' in ac) return ac.error
    const existing: AircraftProfileDocType | null = ac.profile
    if (!existing) return fail(`No aircraft ${quote(String(args.aircraft), 40)}. Use list_aircraft.`)
    const { aircraft: _target, ...fields } = args as Record<string, unknown>
    const built = buildAircraft(toInput(fields), { existing, newId: existing.id, by: await deps.clientName(caller.clientId), now: Date.now() })
    if (built.changed.length === 0) return text(`Nothing to change on ${aircraftLabel(existing)}.`)
    return saveBuild(built, 'updated', existing.updatedAt)
  })
}
