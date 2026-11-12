/**
 * draft_flight_plan: the ICAO flight plan text for a saved route and an
 * aircraft, from the same shared code as the apps' flight plan dialog. Read
 * only: nothing is filed or saved, and the answer says what is missing.
 */
import * as z from 'zod'
import { buildFpl, EMPTY_ANSWERS, type FlightAnswers } from '@open-vfr/shared/fplMessage'
import { QUOTE_NOTE } from './untrusted'
import { departureField, fail, isText, parseDeparture, text, type Ctx } from './mcpContext'

export function registerFlightPlanTool(c: Ctx): void {
  const { deps, caller } = c
  const user = { id: caller.userId }

  c.tool('draft_flight_plan', {
    description: "Draft the ICAO flight plan (message and item 19) for one of the pilot's saved routes and an aircraft: registration, type and wake category, equipment, speed, route, flight time, endurance, colour and the pilot's answers. Returns the text and a list of what is missing or wrong (phone number, off-block time, equipment, type designator...). Ask the pilot for the per-flight answers you lack instead of guessing them: persons on board, pilot name and phone, emergency radio, survival equipment, life jackets, dinghies. It does not file anything: the pilot copies the text into the filing service they use and checks it. Not an official document.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      route: z.string().min(1).max(120).describe('Saved route name (or part of it) or id'),
      aircraft: z.string().max(80).optional().describe('Registration or name; default the route\'s aircraft, else the one selected in the app'),
      departure: departureField,
      levelMode: z.enum(['VFR', 'planned']).optional().describe('VFR (default) writes the word VFR as the level; planned writes the planned levels with the changes along the route'),
      flightType: z.enum(['G', 'N', 'S', 'M', 'X']).optional().describe('Default G (general aviation). X needs an explanation in remarks'),
      alternate: z.string().regex(/^[A-Za-z]{4}$/).optional().describe('Alternate aerodrome, ICAO code'),
      personsOnBoard: z.number().int().min(1).max(99).optional(),
      pilotName: z.string().max(60).optional().describe('Pilot in command'),
      pilotPhone: z.string().max(30).optional().describe('Phone number starting with + and the country code'),
      emergencyRadio: z.array(z.enum(['U', 'V', 'E'])).max(3).optional().describe('U = UHF, V = VHF 121.5 MHz, E = ELT'),
      survival: z.array(z.enum(['P', 'D', 'M', 'J'])).max(4).optional().describe('Polar, desert, maritime, jungle'),
      jackets: z.array(z.enum(['L', 'F', 'U', 'V'])).max(4).optional().describe('Life jackets with light, fluorescein, UHF, VHF'),
      dinghies: z.object({ count: z.number().int().min(0).max(20), capacity: z.number().int().min(0).max(200), covered: z.boolean().optional(), colour: z.string().max(30).optional() }).optional(),
      remarks: z.string().max(120).optional(),
    }),
  }, async (a) => {
    if (!c.canRoutes) return c.noRoutes()
    const dep = parseDeparture(a.departure)
    if (isText(dep)) return dep
    const found = await c.findRoute(a.route)
    if ('error' in found) return found.error
    const route = found.route
    const ac = await c.resolveAircraft(a.aircraft, { useDefault: !route.aircraftId })
    if ('error' in ac) return ac.error
    const profile = ac.profile ?? await deps.briefings.aircraftById(user, route.aircraftId)
    if (!profile) return fail('No aircraft for this route. Name one of the saved aircraft (list_aircraft).')

    const flight: FlightAnswers = {
      ...EMPTY_ANSWERS,
      eobt: new Date(dep ?? Math.ceil((Date.now() + 30 * 60_000) / 300_000) * 300_000),
      levelMode: a.levelMode ?? 'VFR',
      type: a.flightType ?? 'G',
      ...(a.alternate ? { alternate: a.alternate.toUpperCase() } : {}),
      personsOnBoard: a.personsOnBoard ?? 1,
      pilotName: a.pilotName ?? '',
      pilotPhone: a.pilotPhone ?? '',
      emergencyRadio: a.emergencyRadio ?? [],
      survival: a.survival ?? [],
      jackets: a.jackets ?? [],
      dinghies: { count: a.dinghies?.count ?? 0, capacity: a.dinghies?.capacity ?? 0, covered: a.dinghies?.covered ?? false, colour: a.dinghies?.colour ?? '' },
      remarks: a.remarks ?? '',
    }
    const known = await c.pointIndex([]).catch(() => null)
    const aerodromes = known && 'idx' in known ? new Set(known.idx.aerodromes.keys()) : undefined
    const fpl = buildFpl({ waypoints: route.waypoints, legOverrides: route.legOverrides, aircraft: profile, flight, ...(aerodromes ? { aerodromes } : {}) })
    if (!fpl.text) return fail(`The route has no legs to plan. ${fpl.problems.join('; ')}`)
    const lines = [
      `Draft ICAO flight plan for the saved route with ${profile.registration || profile.name}${dep === undefined ? ' (off-block time assumed about 30 minutes from now: ask the pilot)' : ''}:`,
      '',
      fpl.text,
      '',
      'Item 19:',
      ...fpl.supplementary,
      '',
      fpl.problems.length ? `Check before filing: ${fpl.problems.join('; ')}.` : 'Nothing missing that the app can see.',
      'This is a draft, not filed and not an official document. The pilot copies it into the filing service they use and checks every item.',
      QUOTE_NOTE,
    ]
    return text(lines.join('\n'))
  })
}
