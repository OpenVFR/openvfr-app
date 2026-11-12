/**
 * MCP prompts: offered in an assistant's prompt menu, they only instruct the
 * model to use the tools in the right order; the data still comes from the tools.
 */
import * as z from 'zod'
import type { Ctx } from './mcpContext'

export function registerPrompts(c: Ctx): void {
  // ── Prompt: a pre-flight briefing in the right order ──────────────────
  // Offered by assistants in their prompt menu; it only instructs the model,
  // the data still comes from the tools above.
  c.server.registerPrompt('preflight_briefing', {
    title: 'Pre-flight briefing',
    description: 'Brief a flight with OpenVFR data: route, fuel, weather, NOTAMs and warnings, most important first.',
    argsSchema: z.object({
      route: z.string().min(2).max(120).describe('A saved route name, or ICAO codes in order, e.g. "ESSB ESMS"'),
      aircraft: z.string().max(80).optional().describe('Aircraft registration or name (optional)'),
      when: z.string().max(60).optional().describe('Planned departure, e.g. "tomorrow 09:00 UTC" (optional)'),
    }),
  }, ({ route, aircraft, when }) => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          `Give me a pre-flight briefing for ${route}${aircraft ? ` with ${aircraft}` : ''}${when ? `, departing ${when}` : ''}, using the OpenVFR tools.`,
          /^[A-Za-z]{4}(\s+[A-Za-z]{4})+$/.test(route.trim())
            ? '1. Call brief_route with these ICAO codes in order.'
            : '1. Call brief_saved_route with this route (list_saved_routes if the name is unclear).',
          ...(when ? [`   Pass departure as an ISO 8601 UTC time for "${when}" (ask me if unclear): winds, times, NOTAMs and TAFs are for that time.`] : []),
          '2. Read daylight problems and the serious warnings first, then the other warnings, fuel per hop, the altitude per leg, and weather (METAR, the TAF for the time I am there, weather along the way) and NOTAMs at each aerodrome where I take off or land. Mention the "Also check" items.',
          '3. If fuel is short on a hop, call suggest_fuel_stops. For anything about one aerodrome, call aerodrome_status.',
          '4. Say what the briefing could not check (it lists that), and end by reminding me that this is not an official briefing.',
          'Keep it short enough to read out. Quote NOTAM numbers and times exactly; do not invent values the tools did not give.',
        ].join('\n'),
      },
    }],
  }))


  c.server.registerPrompt('plan_route', {
    title: 'Plan a VFR route',
    description: 'Plan and save a VFR route with OpenVFR: points, altitudes that respect terrain and controlled airspace, fuel stops, then a briefing.',
    argsSchema: z.object({
      from: z.string().min(2).max(40).describe('Departure, e.g. ESSB'),
      to: z.string().min(2).max(40).describe('Destination, e.g. ESSV'),
      aircraft: z.string().max(80).optional().describe('Aircraft registration or name (optional)'),
      wishes: z.string().max(300).optional().describe('E.g. "stay below the TMAs", "via the coast", "max 2 h legs" (optional)'),
    }),
  }, ({ from, to, aircraft, wishes }) => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          `Plan a VFR route from ${from} to ${to}${aircraft ? ` with ${aircraft}` : ''} in OpenVFR and save it.${wishes ? ` My wishes: ${wishes}.` : ''}`,
          aircraft
            ? '1. Propose points (ICAO codes, navaids, reporting points as AERODROME/POINT, or coordinates) and save them with create_route, with the aircraft and autoFuelStops: true.'
            : '1. If I have more than one aircraft (list_aircraft), ask me which one first. Then propose points (ICAO codes, navaids, reporting points as AERODROME/POINT, or coordinates) and save them with create_route with that aircraft and autoFuelStops: true; say which aircraft you planned with.',
          '2. Call leg_altitudes. For each leg use the suggested altitude unless I asked otherwise (it names what sets each MSA: mention it). Where the MSA reaches controlled airspace, tell me and offer the options it lists: a clearance (with the frequency), or a way around it, finding points with points_near (airspace name, route and leg) that have no controlled airspace above them or a higher floor. Do not plan a leg below its MSA unless I confirm after you told me the MSA and what sets it.',
          '3. Apply the altitudes and any point changes with update_route, then read the new briefing: fix what it warns about (airspace, restricted areas, fuel) and repeat once if needed.',
          '4. Finish with a short summary: legs with altitude and why, fuel stops, open issues, and the link to the route. Say that I must check it in the app before use and that this is not an official briefing.',
          'Use only numbers the tools give; ask me instead of guessing.',
        ].join('\n'),
      },
    }],
  }))
}
