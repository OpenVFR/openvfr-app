/**
 * MCP tools for the pilot's saved routes: read one, create, update (never
 * delete). Points are resolved against OpenVFR data (routeTools.ts); the
 * levels a write sets are checked against each leg's minimum safe altitude
 * and the legal minimum height before anything is saved; every route an
 * assistant makes or changes is marked "check before use" in the app.
 */
import * as z from 'zod'
import type { AircraftProfileDocType, RouteDocType } from '@open-vfr/shared/types'
import { parseAerodromesGeoJson, type AerodromeFeatureCollectionLike } from '@open-vfr/shared/findDestination'
import { suggestFuelStops, insertFuelStops } from '@open-vfr/shared/fuelStops'
import { FUEL_LABELS } from '@open-vfr/shared/fuelTypes'
import { buildPointIndex } from '@open-vfr/shared/routeIdentifiers'
import { briefingText, SETTINGS_UNREADABLE } from './briefing'
import { quote, QUOTE_NOTE, pointLabel } from './untrusted'
import { buildRoute, legLines, changedLevelLegs, ALT_LIMITS, SPEED_LIMITS, MAX_POINTS, type RouteInput } from './routeTools'
import { allAerodromes, aircraftLabel, departureField, fail, isText, parseDeparture, text, type Ctx, type Text } from './mcpContext'

const routeFields = {
  altitudeFt: z.number().min(ALT_LIMITS[0]).max(ALT_LIMITS[1]).optional().describe('Cruise altitude for every leg, ft AMSL'),
  legs: z.array(z.object({
    leg: z.number().int().min(1).max(MAX_POINTS - 1).describe('Leg number, 1 = first point to second'),
    altitudeFt: z.number().min(ALT_LIMITS[0]).max(ALT_LIMITS[1]).optional().describe('ft AMSL'),
    speedKts: z.number().min(SPEED_LIMITS[0]).max(SPEED_LIMITS[1]).optional().describe('Planned IAS, kt'),
  })).max(MAX_POINTS - 1).optional().describe('Settings for single legs (after altitudeFt)'),
  fuelStops: z.array(z.string().max(64)).max(10).optional().describe('Points (aerodromes between departure and destination) where the aircraft lands and refuels; replaces the current set'),
  aircraft: z.string().max(80).optional().describe('Aircraft registration or name from list_aircraft; "none" for no aircraft. New routes without it use the aircraft selected in the app (or the only one) and say so'),
  departure: departureField,
  belowMsaConfirmed: z.boolean().optional().describe('Set only after you told the pilot a leg\'s MSA and what sets it and the pilot confirmed flying that leg below it. Without it a level below the MSA is not saved. Levels below the legal minimum height are never saved here.'),
  autoFuelStops: z.boolean().optional().describe('With an aircraft: when a hop needs more fuel than the tanks hold, insert the best fuel stop (aircraft fuel types and runway limits) and say which'),
}
const pointsField = z.array(z.string().min(2).max(64)).min(2).max(MAX_POINTS)
  .describe('Points in flight order: ICAO aerodrome codes (ESSB), navaid idents (ARL), reporting points as AERODROME/POINT (ESSB/LAVER), named landmarks as LM/<name> (LM/Hassela kyrka), the pilot\'s saved places as PL/<name> (list_places), or coordinates (5939N01756E). Use points_near to find them. Unknown or ambiguous points are refused, never guessed.')

export function registerRouteTools(c: Ctx): void {
  const { deps, caller } = c
  const user = { id: caller.userId }

  const routeText = (r: RouteDocType) => `${quote(r.name, 80)}:\n${legLines(r, pointLabel).join('\n')}`

  c.tool('get_route', {
    description: "One of the pilot's saved routes in detail: every point, each leg's distance, altitude and speed, fuel stops, the aircraft, and a link that opens it in OpenVFR.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ route: z.string().min(1).max(120).describe('Saved route name (or part of it) or id') }),
  }, async ({ route }) => {
    if (!c.canRoutes) return c.noRoutes()
    const found = await c.findRoute(route)
    if ('error' in found) return found.error
    const r = found.route
    const ac = await deps.briefings.aircraftById(user, r.aircraftId)
    const review = r.assistantReview ? `\n(Check before use: ${r.assistantReview.change === 'created' ? 'made' : 'changed'} by ${quote(r.assistantReview.by, 60)}, not yet saved by the pilot in the app.)` : ''
    return text(`Route ${routeText(r)}\nAircraft: ${ac ? aircraftLabel(ac) : 'none'}. Open: ${c.routeLink(r.id)}${review}\n${QUOTE_NOTE}`)
  })

  /** Insert the best fuel stop plan into a built route when a hop is too long. Returns a note for the answer. */
  async function addFuelStops(built: ReturnType<typeof buildRoute>, ac: AircraftProfileDocType | null): Promise<string> {
    if (!ac) return 'No fuel stops added: give an aircraft for that.'
    const fc = await allAerodromes()
    if (!fc) return 'No fuel stops added: aerodrome data is not available right now.'
    const res = suggestFuelStops(built.doc.waypoints, built.doc.legOverrides, ac, parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike))
    if (res.status === 'not-needed') return `No fuel stop needed with ${aircraftLabel(ac)} (planned with the leg winds set on the route, if any).`
    if (res.status === 'missing-profile-data') return 'No fuel stops added: the aircraft profile needs cruise speed, fuel burn and usable fuel.'
    if (res.status === 'none-found') return 'A fuel stop is needed, but no aerodrome near the route fits the aircraft\'s fuels and runway limits: choose one yourself.'
    const plan = res.plans[0]!
    const next = insertFuelStops(built.doc.waypoints, built.doc.legOverrides, plan)
    built.doc.waypoints = next.waypoints
    built.doc.legOverrides = next.legOverrides
    if (!built.changed.includes('fuel stops') && !built.changed.includes('created')) built.changed.push('fuel stops')
    const review = built.doc.assistantReview
    if (review && review.change !== 'created' && !review.change.includes('fuel stops')) built.doc.assistantReview = { ...review, change: [...review.change, 'fuel stops'] }
    const others = res.plans.slice(1).map(p => p.stops.map(x => x.aerodrome.icao).join('+')).join(', ')
    return `Added fuel stop${plan.stops.length > 1 ? 's' : ''} ${plan.stops.map(x => `${x.aerodrome.icao} ${quote(x.aerodrome.name, 60)} (${x.fuels.map(f => FUEL_LABELS[f]).join('/') || x.aerodrome.fuel.join('/')}, ${x.aerodrome.maxRunwayM} m${x.aerodrome.ppr ? ', PPR' : ''})`).join(' and ')}, +${Math.round(plan.extraMins)} min.${others ? ` Other options: ${others}.` : ''} Fuel listings can be out of date: the pilot should call ahead.`
  }

  /**
   * Check the levels this write sets against each leg's MSA and the legal
   * minimum height, then save and brief. Below the legal minimum: never
   * saved here. Below the MSA: saved only with the pilot's confirmation.
   */
  async function saveRouteAndBrief(
    built: ReturnType<typeof buildRoute>, ac: AircraftProfileDocType | null, verb: 'created' | 'updated', note = '', departureMs?: number,
    existing?: RouteDocType, belowMsaConfirmed = false,
  ): Promise<Text> {
    // Part of the write (limited as one write), not counted as a briefing.
    const b = await deps.briefings.briefRoute(user, { waypoints: built.doc.waypoints, legOverrides: built.doc.legOverrides }, ac, departureMs !== undefined ? { departureMs } : {})
    const set = changedLevelLegs(existing, built.doc).map(i => b.legs[i]).filter((l): l is NonNullable<typeof l> => !!l && l.msaApplies)
    // The pilot's own margins decide what "below the MSA" means: on defaults a level could be saved that they would not accept.
    if (set.length && b.limits.includes(SETTINGS_UNREADABLE)) return fail('Not saved: your own MSA margins could not be read right now, so the levels cannot be checked against them. Try again later.')
    const ft = (n: number) => `${n.toLocaleString('en-US')} ft`
    const illegal = set.filter(l => l.legalMinFt !== null && l.plannedFt < l.legalMinFt)
    if (illegal.length) {
      return fail(`Not saved. ${illegal.map(l => `Leg ${l.leg} at ${ft(l.plannedFt)} is below the legal minimum height there: ${ft(l.legalMinFt!)} (500 ft above the highest ground or obstacle within 150 m of the track; over towns 1,000 ft above obstacles within 600 m, which is not checked)`).join('; ')}. Choose a higher level. Lower flying (e.g. for take-off and landing) is set by the pilot in the app, not here.`)
    }
    const below = set.filter(l => l.msaFt > 0 && l.plannedFt < l.msaFt)
    const describe = (l: (typeof below)[number]) => `leg ${l.leg} at ${ft(l.plannedFt)} is ${l.msaFt - l.plannedFt} ft below its MSA of ${ft(l.msaFt)}${l.msaCause ? ` (set by ${quote(l.msaCause, 120)})` : ''}`
    if (below.length && !belowMsaConfirmed) {
      return fail(`Not saved: ${below.map(describe).join('; ')}. The MSA is the pilot's safety margin over terrain and obstacles, not a legal limit. Tell the pilot this, including what sets it, and ask whether to plan below it. Only if they confirm, call again with belowMsaConfirmed: true; otherwise use a level at or above the MSA.\n${QUOTE_NOTE}`)
    }
    await c.save.route(built.doc, verb === 'updated' ? existing?.updatedAt : undefined)
    console.log(`[mcp] route ${verb} user=${caller.userId} client=${caller.clientId} id=${built.doc.id} change=${built.changed.join(',')}${below.length ? ` belowMsa=${below.map(l => l.leg).join(',')}` : ''}`)
    const lines = [
      `${verb === 'created' ? 'Saved new route' : `Updated route (${built.changed.join(', ') || 'nothing changed'})`} ${routeText(built.doc)}`,
      `Open it in OpenVFR: ${c.routeLink(built.doc.id)}`,
      'The app marks it "check before use" until the pilot opens and saves it there; it reaches their devices at the next sync.',
    ]
    if (note) lines.push(note)
    if (below.length) lines.push(`Below the MSA as the pilot confirmed: ${below.map(describe).join('; ')}. The app keeps showing it as a pre-flight warning.`)
    const unknown = set.filter(l => l.msaFt <= 0)
    if (unknown.length) lines.push(`No terrain data for leg ${unknown.map(l => l.leg).join(', ')}: its level was not checked against an MSA or the minimum height.`)
    if (built.warnings.length) lines.push(`Check these: ${built.warnings.join('; ')}.`)
    lines.push('', 'Briefing of the saved route (fix warnings with update_route):', briefingText(b), QUOTE_NOTE)
    return text(lines.join('\n'))
  }

  c.tool('create_route', {
    description: 'Save a new route for the pilot in OpenVFR and brief it. Points are resolved against OpenVFR data; the answer has the legs, a link that opens the route in the app, and the briefing warnings (airspace, terrain, fuel, NOTAMs, weather) so you can improve the route with update_route. Plan VFR only; the pilot checks the route in the app before use.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: z.object({
      name: z.string().min(1).max(80).optional().describe('Route name; default "FROM – TO"'),
      points: pointsField,
      ...routeFields,
    }),
  }, async (args) => {
    if (!c.canRoutesWrite) return c.noRoutesWrite()
    if (!c.canRoutes) return c.noRoutes()
    const dep = parseDeparture(args.departure)
    if (isText(dep)) return dep
    const got = await c.pointIndex(args.points)
    if ('error' in got) return got.error
    const ac = await c.resolveAircraft(args.aircraft, { useDefault: true, allowNone: true })
    if ('error' in ac) return ac.error
    if (args.name) {
      const clash = (await deps.briefings.savedRoutes(user)).find(r => r.id !== 'current' && r.name.toLowerCase() === args.name!.trim().toLowerCase())
      if (clash) return fail(`A route named ${quote(clash.name, 80)} exists. Use update_route to change it, or choose another name.`)
    }
    const input: RouteInput = { name: args.name, points: args.points, altitudeFt: args.altitudeFt, legs: args.legs, fuelStops: args.fuelStops, aircraftId: ac.id }
    const built = buildRoute(input, { idx: got.idx, newId: crypto.randomUUID(), by: await deps.clientName(caller.clientId), now: Date.now() })
    const note = [ac.note, args.autoFuelStops ? await addFuelStops(built, ac.profile) : ''].filter(Boolean).join('\n')
    return saveRouteAndBrief(built, ac.profile, 'created', note, dep, undefined, args.belowMsaConfirmed === true)
  })

  c.tool('update_route', {
    description: "Change one of the pilot's saved routes: new point list (points already on the route keep their settings), altitude for all or single legs, speed, fuel stops, aircraft, name. Only the given fields change. Answers with the legs, link and a new briefing. Cannot delete a route.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: z.object({
      route: z.string().min(1).max(120).describe('Saved route name or id'),
      name: z.string().min(1).max(80).optional().describe('New name'),
      points: pointsField.optional(),
      ...routeFields,
    }),
  }, async (args) => {
    if (!c.canRoutesWrite) return c.noRoutesWrite()
    if (!c.canRoutes) return c.noRoutes()
    const dep = parseDeparture(args.departure)
    if (isText(dep)) return dep
    const found = await c.findRoute(args.route)
    if ('error' in found) return found.error
    const existing = found.route
    const got = args.points ? await c.pointIndex(args.points) : { idx: buildPointIndex({}) }
    if ('error' in got) return got.error
    const ac = await c.resolveAircraft(args.aircraft, { allowNone: true })
    if ('error' in ac) return ac.error
    const input: RouteInput = { name: args.name, points: args.points, altitudeFt: args.altitudeFt, legs: args.legs, fuelStops: args.fuelStops, aircraftId: ac.id }
    const built = buildRoute(input, { existing, idx: got.idx, newId: existing.id, by: await deps.clientName(caller.clientId), now: Date.now() })
    const profile = args.aircraft !== undefined ? ac.profile : await deps.briefings.aircraftById(user, built.doc.aircraftId)
    const note = args.autoFuelStops ? await addFuelStops(built, profile) : ''
    if (built.changed.length === 0) return text(`Nothing to change on ${quote(existing.name, 80)}.${note ? ` ${note}` : ''}\n${QUOTE_NOTE}`)
    return saveRouteAndBrief(built, profile, 'updated', note, dep, existing, args.belowMsaConfirmed === true)
  })
}
