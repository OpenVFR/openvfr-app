/**
 * MCP tools that brief and look things up: saved routes and aircraft lists,
 * briefings, aerodrome status, fuel stops, altitudes per leg, points near a
 * place. Read-only; the changing tools are in mcpRouteTools.ts and friends.
 */
import * as z from 'zod'
import type { RouteWaypoint } from '@open-vfr/shared/routeCalc'
import { parseAerodromesGeoJson, type AerodromeFeatureCollectionLike } from '@open-vfr/shared/findDestination'
import { suggestFuelStops } from '@open-vfr/shared/fuelStops'
import { FUEL_LABELS, preferenceLabel } from '@open-vfr/shared/fuelTypes'
import { notamTitle } from '@open-vfr/shared/notamQCode'
import { metarSurfaceWind, crosswindExceedances, thresholdsByIcao } from '@open-vfr/shared/crosswindCheck'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { resolveRoutePoints } from '@open-vfr/shared/routeIdentifiers'
import { allPoints, pointsNearPosition, pointsNearLeg, pointsNearAirspaceEdge, type NearPoint, type PointKind } from '@open-vfr/shared/pointsNear'
import { briefingText, legLine, BRIEFING_DISCLAIMER } from './briefing'
import { quote, QUOTE_NOTE, PLAIN_IDENTIFIER } from './untrusted'
import { loadCountryDataset } from './briefingData'
import { getNotamsForIcao, notamStatus } from './notam'
import { MAX_POINTS } from './routeTools'
import { allAerodromes, aircraftLabel, departureField, fail, isText, parseDeparture, routeLine, servedCountries, text, type Ctx } from './mcpContext'

const KIND_IN: Record<string, PointKind> = { aerodrome: 'aerodrome', navaid: 'navaid', 'reporting point': 'waypoint', landmark: 'landmark' }

function nearLine(p: NearPoint): string {
  const kind = p.kind === 'waypoint' ? 'reporting point' : p.kind
  const what = p.kind === 'landmark' ? `landmark, ${p.detail.replace(/_/g, ' ')}` : p.kind === 'waypoint' ? p.detail : `${kind}${p.detail && p.detail !== p.identifier ? ` ${quote(p.detail, 40)}` : ''}`
  const where = p.edgeNm !== undefined ? `${Math.abs(p.edgeNm)} NM ${p.edgeNm >= 0 ? 'outside' : 'inside'} the edge`
    : p.alongNm !== undefined ? `NM ${p.alongNm} along the leg, ${p.distNm.toFixed(1)} NM ${p.side} of track`
    : `${p.distNm.toFixed(1)} NM away`
  const above = p.controlledAbove
    ? `${p.controlledAbove.floorFt <= 0 ? 'inside' : 'under'} ${quote(p.controlledAbove.name, 60)} (class ${p.controlledAbove.cls}${p.controlledAbove.floorFt > 0 ? ` from ${p.controlledAbove.floorFt.toLocaleString('en-US')} ft` : ', from the surface'})`
    : 'no controlled airspace above'
  const id = PLAIN_IDENTIFIER.test(p.identifier) ? p.identifier : quote(p.identifier, 60)
  return `- ${id} (${what}): ${where}; ${above}`
}

export function registerBriefingTools(c: Ctx): void {
  const { deps, caller } = c
  const user = { id: caller.userId }

  c.tool('list_saved_routes', {
    description: "List the pilot's saved routes in OpenVFR (name, points, distance). Use a name with brief_saved_route or suggest_fuel_stops.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}),
  }, async () => {
    if (!c.canRoutes) return c.noRoutes()
    const routes = (await deps.briefings.savedRoutes(user)).filter(r => r.id !== 'current')
    if (routes.length === 0) return text('No saved routes. Save a route in the OpenVFR app first.')
    return text(`Saved routes (newest first):\n${routes.slice(0, 30).map(routeLine).join('\n')}\n${QUOTE_NOTE}`)
  })

  c.tool('list_aircraft', {
    description: "List the pilot's aircraft profiles in OpenVFR with the key planning numbers.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}),
  }, async () => {
    if (!c.canRoutes) return c.noRoutes()
    const list = await deps.briefings.userAircraft(user)
    if (list.length === 0) return text('No aircraft profiles yet.')
    return text(list.map(a => `- ${aircraftLabel(a)} (${a.icaoType || a.category}): cruise ${a.cruiseIas} kt IAS, ${a.fuelBurnLhr} L/h, ${a.maxFuelL} L usable` +
      `${a.fuelTypes?.length ? `, fuel ${a.fuelTypes.map((f, i) => `${FUEL_LABELS[f]}${i === 0 ? ' (preferred)' : ''}`).join(', ')}` : ''}` +
      `${a.maxCrosswindKts ? `, max crosswind ${a.maxCrosswindKts} kt` : ''}`).join('\n') + `\n${QUOTE_NOTE}`)
  })

  c.tool('brief_saved_route', {
    description: 'Pre-flight briefing of one of the pilot\'s saved routes: distance, time and fuel per hop, METAR/TAF and NOTAMs at the departure, fuel stops and destination, and warnings (airspace, NOTAM areas, fuel, equipment, crosswind, runway length). Read the warnings out first.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      route: z.string().min(1).max(120).describe('Saved route name (or part of it) or id'),
      aircraft: z.string().max(80).optional().describe('Aircraft registration or name; default: the route\'s own aircraft, else the one selected in the app'),
      departure: departureField,
    }),
  }, async ({ route, aircraft, departure }) => {
    if (!c.canRoutes) return c.noRoutes()
    const dep = parseDeparture(departure)
    if (isText(dep)) return dep
    const found = await c.findRoute(route)
    if ('error' in found) return found.error
    // The route's own aircraft unless one is named; none on the route = the app's selection.
    const ac = await c.resolveAircraft(aircraft, { useDefault: !found.route.aircraftId })
    if ('error' in ac) return ac.error
    const limited = c.takeBriefing()
    if (limited) return limited
    const r = await deps.briefings.briefSavedRoute(user, found.route, ac.id, dep)
    return text(briefingText(r.briefing) + (ac.note ? `\n${ac.note}` : ''))
  })

  c.tool('brief_route', {
    description: 'Pre-flight briefing for a route given as ICAO aerodrome codes in order, e.g. ["ESSB","ESMS"]. Optional aircraft (needs access to saved aircraft) adds fuel, crosswind and runway checks; mark intermediate aerodromes as fuel stops with fuelStops.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      aerodromes: z.array(z.string().regex(/^[A-Za-z]{4}$/)).min(2).max(20).describe('ICAO codes in flight order'),
      fuelStops: z.array(z.string().regex(/^[A-Za-z]{4}$/)).max(10).optional().describe('Intermediate ICAO codes where the aircraft lands and refuels'),
      aircraft: z.string().max(80).optional(),
      cruiseAltFt: z.number().int().min(500).max(20000).optional().describe('Planned cruise altitude, ft'),
      departure: departureField,
    }),
  }, async ({ aerodromes, fuelStops, aircraft, cruiseAltFt, departure }) => {
    const dep = parseDeparture(departure)
    if (isText(dep)) return dep
    const fc = await allAerodromes()
    if (!fc) return fail('Aerodrome data is not available right now.')
    const byIcao = new Map(parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike).map(a => [a.icao.toUpperCase(), a]))
    const stops = new Set((fuelStops ?? []).map(s => s.toUpperCase()))
    const waypoints: RouteWaypoint[] = []
    for (const code of aerodromes.map(a => a.toUpperCase())) {
      const ad = byIcao.get(code)
      if (!ad) return fail(`${code} is not in OpenVFR's aerodrome data.`)
      waypoints.push({ lat: ad.lat, lng: ad.lng, name: code, elevationFt: ad.elevationFt, ...(stops.has(code) ? { fuelStop: true } : {}) })
    }
    const ac = await c.resolveAircraft(aircraft, { useDefault: true })
    if ('error' in ac) return ac.error
    const limited = c.takeBriefing()
    if (limited) return limited
    const legOverrides = waypoints.slice(0, -1).map(() => (cruiseAltFt ? { altFt: cruiseAltFt } : {}))
    const b = await deps.briefings.briefRoute(user, { waypoints, legOverrides }, ac.profile, dep !== undefined ? { departureMs: dep } : {})
    return text(briefingText(b) + (ac.note ? `\n${ac.note}` : ''))
  })

  c.tool('aerodrome_status', {
    description: 'Current status of one aerodrome: runways, fuel, PPR, METAR/TAF, NOTAMs (with their texts) and, with an aircraft, whether the reported crosswind is within its limit.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      icao: z.string().regex(/^[A-Za-z]{4}$/),
      aircraft: z.string().max(80).optional(),
    }),
  }, async ({ icao, aircraft }) => {
    const code = icao.toUpperCase()
    const ac = await c.resolveAircraft(aircraft, { useDefault: true })
    if ('error' in ac) return ac.error
    const fc = await allAerodromes()
    const f = fc?.features.find(x => String((x.properties as Record<string, unknown> | null)?.['icao'] ?? '').toUpperCase() === code)
    const ad = f ? parseAerodromesGeoJson({ features: [f] } as unknown as AerodromeFeatureCollectionLike)[0] : undefined
    const wx = await deps.weather(caller.userId, code).catch(() => null)
    const notams = (getNotamsForIcao(code).notams as unknown as NotamItem[])
      .filter(n => !n.expires || Date.parse(n.expires) > Date.now())
    const lines: string[] = []
    lines.push(ad ? `${code} ${quote(ad.name, 80)}, elevation ${ad.elevationFt} ft. ${c.adLink(code)}` : `${code} (not in OpenVFR's aerodrome data).`)
    if (ad) {
      const rwys = (ad.runways ?? []).map(r => `${r.lengthM} m ${r.surface || '?'}`).join(', ')
      lines.push(`Runways: ${rwys || 'unknown'}. Fuel listed: ${ad.fuel.join(', ') || 'none'}.${ad.ppr ? ' PPR required.' : ''}`)
    }
    lines.push(`METAR: ${wx?.metar ? quote(wx.metar, 300) : 'not available'}`)
    if (wx?.taf) lines.push(`TAF: ${quote(wx.taf, 600)}`)
    if (ac.note) lines.push(ac.note)
    if (ac.profile) {
      // Only an answer when it was really checked: calm or variable wind, no runway data or no limit is "not checked".
      const a = ac.profile
      const w = metarSurfaceWind(wx?.metar)
      const th = fc ? thresholdsByIcao(fc) : null
      const why = !a.maxCrosswindKts ? `${aircraftLabel(a)} has no maximum crosswind set`
        : !w ? 'no surface wind in the METAR'
        : w.calm || w.variable || w.dirDeg == null ? 'the wind is calm or variable'
        : !th?.has(code) ? 'no runway directions in the aerodrome data' : ''
      if (why) lines.push(`Crosswind not checked: ${why}.`)
      else {
        const x = crosswindExceedances([{ icao: code, role: 'aerodrome' }], new Map([[code, w!]]), th!, a.maxCrosswindKts!)
        lines.push(x.length ? `Crosswind ${x[0]!.crosswindKt} kt on the best runway, above ${aircraftLabel(a)}'s ${a.maxCrosswindKts} kt limit.` : `Crosswind within ${aircraftLabel(a)}'s ${a.maxCrosswindKts} kt limit.`)
      }
    }
    const ns = notamStatus()
    lines.push(!ns.available ? 'NOTAMs: not available right now, none checked.' : notams.length === 0 ? `No current NOTAMs (data from ${ns.asOf?.slice(11, 16) ?? '?'}Z).` : `${notams.length} NOTAM${notams.length > 1 ? 's' : ''} (data from ${ns.asOf?.slice(11, 16) ?? '?'}Z):`)
    for (const n of notams.slice(0, 15)) lines.push(`- ${n.id} ${quote(notamTitle(n), 120)} (${n.effective ?? '?'} to ${n.expires ?? 'PERM'}): ${quote(n.text, 600)}`)
    lines.push(QUOTE_NOTE)
    lines.push(BRIEFING_DISCLAIMER)
    return text(lines.join('\n'))
  })

  c.tool('suggest_fuel_stops', {
    description: "Suggest aerodromes along one of the pilot's saved routes to land and refuel, matching the aircraft's fuel types (preferred first) and runway limits, with each hop's time and fuel left on landing.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      route: z.string().min(1).max(120),
      aircraft: z.string().max(80).optional(),
    }),
  }, async ({ route, aircraft }) => {
    if (!c.canRoutes) return c.noRoutes()
    const found = await c.findRoute(route)
    if ('error' in found) return found.error
    const r = found.route
    // Named aircraft, else the route's own, else the app's selection.
    const named = await c.resolveAircraft(aircraft)
    if ('error' in named) return named.error
    const ac = named.profile ?? (await deps.briefings.aircraftById(user, r.aircraftId)) ?? (await c.resolveAircraft(undefined, { useDefault: true }).then(d => ('profile' in d ? d.profile : null)))
    if (!ac) return fail('No aircraft for this route. Name one of the saved aircraft.')
    const fc = await allAerodromes()
    if (!fc) return fail('Aerodrome data is not available right now.')
    const res = suggestFuelStops(r.waypoints, r.legOverrides, ac, parseAerodromesGeoJson(fc as unknown as AerodromeFeatureCollectionLike))
    if (res.status === 'not-needed') return text(`${quote(r.name, 80)} needs no fuel stop with ${aircraftLabel(ac)} (planned without wind).`)
    if (res.status === 'missing-profile-data') return fail('The aircraft profile needs cruise speed, fuel burn and usable fuel.')
    if (res.status === 'none-found') return text('No aerodrome near the route fits the aircraft\'s fuel and runway limits. Add a stop by hand in the app.')
    const out = res.plans.map((p, i) => `${i + 1}. ` + p.stops.map(s =>
      `${s.aerodrome.icao} ${quote(s.aerodrome.name, 80)} (${s.fuels.map(f => FUEL_LABELS[f]).join('/') || s.aerodrome.fuel.join('/')}` +
      `${s.fuelRank > 0 ? `, ${preferenceLabel(s.fuelRank)} choice` : ''}, ${s.aerodrome.maxRunwayM} m${s.aerodrome.ppr ? ', PPR' : ''}) ${c.adLink(s.aerodrome.icao)}`).join(' then ') +
      `; hops ${p.hops.map(h => `${h.from}→${h.to} ${Math.round(h.enrouteMins)} min, ${Math.round(h.landingFuelL)} L left`).join('; ')}; +${Math.round(p.extraMins)} min flying.`)
    return text(`Fuel stop options for ${quote(r.name, 80)} with ${aircraftLabel(ac)}:\n${out.join('\n')}\nFuel listings come from published aerodrome data and can be out of date: check the AIP or call ahead. Add a stop in the app with "Suggest fuel stop".\n${QUOTE_NOTE}`)
  })

  c.tool('leg_altitudes', {
    description: "Altitude planning per leg of a saved route (create_route and update_route answers already include the same table: call this after they returned, not in parallel): minimum safe altitude (terrain, obstacles and the pilot's own margins), controlled airspace over the leg (floor, ceiling, where along the leg, frequency), restricted areas, and a suggested altitude that stays clear of terrain, below controlled airspace where possible, and on a VFR semicircular level. When the MSA reaches controlled airspace it says so and lists the options (clearance or route around); it never suggests flying below the MSA (the pilot may still choose to: update_route with belowMsaConfirmed after telling them the MSA and its cause). Change levels with update_route.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ route: z.string().min(1).max(120).describe('Saved route name or id') }),
  }, async ({ route }) => {
    if (!c.canRoutes) return c.noRoutes()
    const found = await c.findRoute(route)
    if ('error' in found) return found.error
    const limited = c.takeBriefing()
    if (limited) return limited
    const r = await deps.briefings.briefSavedRoute(user, found.route)
    const b = r.briefing
    const src = b.terrainSource === 'dem' ? 'Terrain from the elevation model.' : b.terrainSource === 'grid' ? 'Terrain from the maximum-elevation grid (conservative: highest point per ~460 m cell).' : 'No terrain data: minimum safe altitudes unknown.'
    const msaWarn = b.warnings.filter(w => /MSA|minimum safe|terrain|obstacle/i.test(`${w.title} ${w.detail}`))
    return text([
      `Altitudes for ${quote(r.route.name, 80)} (planned altitudes as saved; default altitude where a leg has none). ${src}`,
      ...b.legs.map(legLine),
      ...(msaWarn.length ? ['Related warnings:', ...msaWarn.map(w => `- ${w.leg ? `(leg ${w.leg}) ` : ''}${w.title}: ${quote(w.detail, 300)}`)] : []),
      'Airspace data can be out of date and activity times are not checked: confirm with the AIP and NOTAMs.',
      QUOTE_NOTE,
      BRIEFING_DISCLAIMER,
    ].join('\n'))
  })

  c.tool('points_near', {
    description: 'Find route points near a place, along a leg of a saved route, or just outside (or inside) a named airspace, to plan a way around it: aerodromes, navaids, VFR reporting points and named landmarks (churches, water towers, windmills). Each comes with the identifier to use in create_route/update_route and the lowest controlled airspace above it, so you can pick points below a TMA floor or outside a control zone. Then check the result with leg_altitudes.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      near: z.string().min(2).max(60).optional().describe('Centre: an identifier (ESSB, ARL, ESSB/LAVER), a saved place (PL/Cabin) or coordinates (5939N01756E)'),
      route: z.string().min(1).max(120).optional().describe('Saved route name, with leg'),
      leg: z.number().int().min(1).max(MAX_POINTS).optional().describe('Leg number of the route (1 = first to second point)'),
      airspace: z.string().min(2).max(60).optional().describe('Airspace name as in warnings and leg_altitudes, e.g. "STOCKHOLM F": points near its edge (with route+leg: only near that leg)'),
      inside: z.boolean().optional().describe('With airspace: points inside it near the edge instead of outside'),
      radiusNm: z.number().min(1).max(30).optional().describe('Search distance, NM (default 10): from the centre, the leg, or the airspace edge'),
      kinds: z.array(z.enum(['aerodrome', 'navaid', 'reporting point', 'landmark'])).max(4).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
  }, async (args) => {
    const got = await c.pointIndex(args.near ? [args.near] : [])
    if ('error' in got) return got.error
    const pts = allPoints(got.idx)
    const airspaceFc = await loadCountryDataset('airspace', await servedCountries())
    const radius = args.radiusNm ?? 10
    const kinds = args.kinds?.map(k => KIND_IN[k]!)
    const opts = { ...(kinds ? { kinds } : {}), airspace: airspaceFc, limit: args.limit ?? 15 }
    let leg: [RouteWaypoint, RouteWaypoint] | null = null
    if (args.route || args.leg) {
      if (!c.canRoutes) return c.noRoutes()
      if (!args.route || !args.leg) return fail('Give both route and leg.')
      const found = await c.findRoute(args.route)
      if ('error' in found) return found.error
      const w = found.route.waypoints
      if (args.leg > w.length - 1) return fail(`That route has ${w.length - 1} legs.`)
      leg = [w[args.leg - 1]!, w[args.leg]!]
    }
    let head: string
    let list: NearPoint[]
    if (args.airspace) {
      if (!airspaceFc) return fail('Airspace data is not available right now.')
      const r = pointsNearAirspaceEdge(pts, airspaceFc, args.airspace, radius, { ...opts, ...(args.inside ? { inside: true } : {}), ...(leg ? { near: leg, nearNm: 15 } : {}) })
      if (r.matched.length === 0) return fail(`No airspace named ${quote(args.airspace, 60)}. Use the names from warnings or leg_altitudes.`)
      if (r.matched.length > 1) return fail(`Several airspaces match: ${r.matched.slice(0, 10).map(n => quote(n, 60)).join(', ')}. Use the full name.\n${QUOTE_NOTE}`)
      head = `Points ${args.inside ? 'inside' : 'outside'} ${quote(r.matched[0], 60)} within ${radius} NM of its edge${leg ? ` near leg ${args.leg}` : ''}:`
      list = r.points
    } else if (leg) {
      head = `Points within ${radius} NM of leg ${args.leg} (${quote(leg[0].name ?? '?', 40)} → ${quote(leg[1].name ?? '?', 40)}):`
      list = pointsNearLeg(pts, leg[0], leg[1], radius, opts)
    } else if (args.near) {
      const centre = resolveRoutePoints([args.near], got.idx)[0]!
      if (!centre.ok) return fail(`${quote(args.near, 60)}: ${centre.reason}.`)
      head = `Points within ${radius} NM of ${quote(args.near, 60)}:`
      list = pointsNearPosition(pts, centre.point, radius, opts).filter(p => p.distNm > 0.05)
    } else {
      return fail('Give near, route and leg, or airspace.')
    }
    if (list.length === 0) return text(`${head} none found. Try a larger radiusNm or other kinds.`)
    return text([head, ...list.map(nearLine), 'Landmarks are named buildings from OpenStreetMap: check they are visible from the air before using them as turning points.', QUOTE_NOTE].join('\n'))
  })
}
