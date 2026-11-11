/**
 * Fuel-stop suggestions: when a route is longer than the aircraft can fly on
 * one tank, find aerodromes near the route that sell a fuel the aircraft can
 * use and have a runway it accepts, and choose the stops that add the least
 * flying time.
 *
 * Every hop (departure -> stop -> ... -> destination) is checked with the
 * same fuel plan as the route itself (`computeFuelPlan`: taxi, climb, cruise,
 * descent, contingency and all reserves, with the leg winds), against the
 * aircraft's usable fuel. A hop is possible when its minimum required fuel
 * fits in the tanks with a small margin (`windSlack`) for the forecast on
 * the new legs.
 *
 * The search is a shortest path over the route's own points plus the
 * candidate aerodromes, ordered along the route: cost = flying time plus a
 * fixed penalty per stop (more for a stop without the aircraft's preferred
 * fuel) plus a small term that grows with the square of each
 * hop's time (so hops of similar length win over a stop just after take-off)
 * and a minute per litre a hop's spare fuel falls below 15 % of the tanks,
 * with at most `maxStops` new stops. Route points already marked `fuelStop`
 * are kept as stops. Alternatives are found by running it again with one of
 * the best plan's stops left out.
 *
 * Pure and deterministic: no network. Weather and NOTAMs at a stop are for
 * the caller to add.
 */
import type { AircraftProfileDocType, FuelCode, LegOverride } from './types'
import { distanceNm, type RouteWaypoint } from './routeCalc'
import { computeFuelPlan, computeTripFuelPlans, type FuelHop } from './fuelCalc'
import { matchingFuels } from './fuelTypes'
import { isHard, type AerodromeEntry } from './findDestination'
import { runwaysAllowStop } from './runwayPerformance'

type Wind = { dirDeg: number; speedKts: number } | null | undefined

export interface FuelStopOptions {
  /** Largest extra distance a stop may add to the leg it splits, NM. Default 25. */
  maxDetourNm?: number
  /** Most stops in one plan. Default 3. */
  maxStops?: number
  /** Minutes added per stop when ranking (landing, refuelling, departure). Default 30. */
  stopPenaltyMin?: number
  /** Plans to return. Default 3. */
  maxPlans?: number
  /** Most candidate aerodromes considered (closest to the route first). Default 60. */
  maxCandidates?: number
  /** ICAO codes never suggested. */
  excludeIcaos?: readonly string[]
  /** Minutes added per step down the aircraft's fuel preference list (2nd choice = 1 step). Default 15. */
  fuelRankPenaltyMin?: number
  /**
   * Share of the tanks a hop must leave unplanned, default 0.05. A hop between
   * a stop and a route point is planned with the wind of the leg it splits;
   * once inserted, the new legs get their own forecast, which can be a little
   * worse. The margin keeps a suggested stop valid after insertion.
   */
  windSlack?: number
}

export interface FuelStop {
  aerodrome: AerodromeEntry
  /** Aircraft fuel grades the aerodrome lists, best preferred first; empty when the profile has none set. */
  fuels: FuelCode[]
  /** Preference rank of the best grade on offer: 0 = the aircraft's preferred fuel. 0 when no fuel types are set. */
  fuelRank: number
  /** Index in the original route after which the stop goes. */
  insertAfter: number
  /** Extra distance the stop adds to the leg it splits, NM. */
  detourNm: number
}

export interface FuelStopHop {
  from: string
  to: string
  enrouteMins: number
  /** Minimum required fuel for this hop (fuel plan total). */
  minFuelL: number
  /** Usable fuel left on landing when departing with full tanks. */
  landingFuelL: number
}

export interface FuelStopPlan {
  stops: FuelStop[]
  hops: FuelStopHop[]
  /** Flying time of the whole trip with the stops, minutes. */
  enrouteMins: number
  /** Extra flying time against the route without stops, minutes. */
  extraMins: number
}

export type FuelStopResult =
  | { status: 'not-needed'; hops: FuelHop[] }
  | { status: 'missing-profile-data' }
  | { status: 'found'; plans: FuelStopPlan[]; fuelTypesUnset: boolean }
  | { status: 'none-found'; fuelTypesUnset: boolean; candidates: number }

type RankedPlan = FuelStopPlan & { cost: number }

/** A point of the search: a route waypoint, or a candidate on a leg. */
interface Node {
  /** Route leg the point is on (a waypoint k is on leg k at t = 0). */
  leg: number
  t: number
  point: RouteWaypoint
  stop?: FuelStop
  /** Original waypoint index, for route points. */
  wp?: number
}

function label(w: RouteWaypoint, i: number): string {
  return w.name || `WP${i + 1}`
}

/** Whether the aerodrome has a runway the aircraft accepts. */
function runwayOk(a: AerodromeEntry, minM: number, hardOnly: boolean): boolean {
  const rwys = a.runways && a.runways.length > 0
    ? a.runways
    : [{ lengthM: a.maxRunwayM, surface: isHard(a.surfaces) ? 'ASPH' : (a.surfaces[0] ?? '') }]
  return rwys.some(r =>
    (minM <= 0 || r.lengthM >= minM) &&
    (!hardOnly || r.surface === 'ASPH' || r.surface === 'CONC'),
  )
}

/** Usable profile for fuel planning: needs fuel, speed and burn. */
function hasFuelModel(p: AircraftProfileDocType): boolean {
  return p.maxFuelL > 0 && p.fuelBurnLhr > 0 && p.cruiseIas > 0
}

export function suggestFuelStops(
  waypoints:    RouteWaypoint[],
  legOverrides: LegOverride[],
  profile:      AircraftProfileDocType,
  aerodromes:   readonly AerodromeEntry[],
  legWinds?:    Wind[],
  opts:         FuelStopOptions = {},
): FuelStopResult {
  if (waypoints.length < 2 || !hasFuelModel(profile)) return { status: 'missing-profile-data' }

  const maxDetourNm   = opts.maxDetourNm   ?? 25
  const maxStops      = opts.maxStops      ?? 3
  const stopPenalty   = opts.stopPenaltyMin ?? 30
  const rankPenalty   = opts.fuelRankPenaltyMin ?? 15
  const maxPlans      = opts.maxPlans      ?? 3
  const maxCandidates = opts.maxCandidates ?? 60
  const capacity      = profile.maxFuelL
  const hopLimitL     = capacity * (1 - (opts.windSlack ?? 0.05))

  const trip = computeTripFuelPlans(waypoints, legOverrides, profile, legWinds)
  const tripMins = trip.reduce((s, h) => s + h.plan.enrouteMins, 0)
  if (tripMins <= 0) return { status: 'missing-profile-data' }
  if (trip.every(h => h.plan.totalMinFuelL <= capacity)) return { status: 'not-needed', hops: trip }
  const BALANCE = 0.1 / 60   // per minute² of hop time
  /** Spare fuel a hop should keep beyond its minimum; each litre less costs a minute. */
  const COMFORT_L = 0.15 * capacity

  // ── Candidates ──────────────────────────────────────────────────────────
  const wanted = profile.fuelTypes ?? []
  const fuelTypesUnset = wanted.length === 0
  const exclude = new Set([
    ...(opts.excludeIcaos ?? []),
    ...waypoints.map(w => (w.name ?? '').toUpperCase()).filter(Boolean),
  ].map(s => s.toUpperCase()))
  const allowHeliports = profile.category === 'HELI'

  const candidates: FuelStop[] = []
  for (const a of aerodromes) {
    if (!a.icao || exclude.has(a.icao.toUpperCase())) continue
    if (a.type === 'HP' && !allowHeliports) continue
    const fuels = fuelTypesUnset ? [] : matchingFuels(a.fuel, wanted)
    if (fuelTypesUnset ? a.fuel.length === 0 : fuels.length === 0) continue
    if (!runwayOk(a, profile.minRunwayM ?? 0, profile.hardRunwayOnly === true)) continue
    // With take-off and landing distances in the profile: a runway long enough for both (standard temperature).
    if (a.runways && a.runways.length > 0 && !runwaysAllowStop(profile, a.runways, a.elevationFt)) continue

    // Leg this aerodrome would split with the least detour.
    let best = -1, bestDetour = Infinity
    for (let i = 0; i < waypoints.length - 1; i++) {
      const d = distanceNm(waypoints[i], a) + distanceNm(a, waypoints[i + 1]) - distanceNm(waypoints[i], waypoints[i + 1])
      if (d < bestDetour) { bestDetour = d; best = i }
    }
    if (best < 0 || bestDetour > maxDetourNm) continue
    candidates.push({ aerodrome: a, fuels, fuelRank: fuelTypesUnset ? 0 : wanted.indexOf(fuels[0]), insertAfter: best, detourNm: Math.max(0, bestDetour) })
  }
  candidates.sort((x, y) => x.detourNm - y.detourNm)
  candidates.length = Math.min(candidates.length, maxCandidates)
  if (candidates.length === 0) return { status: 'none-found', fuelTypesUnset, candidates: 0 }

  // ── Nodes ordered along the route ───────────────────────────────────────
  const nodes: Node[] = waypoints.map((w, k) => ({ leg: k, t: 0, point: w, wp: k }))
  for (const c of candidates) {
    const a = waypoints[c.insertAfter], b = waypoints[c.insertAfter + 1]
    const da = distanceNm(a, c.aerodrome), db = distanceNm(c.aerodrome, b)
    nodes.push({
      leg: c.insertAfter,
      t: da + db > 0 ? Math.min(0.999, Math.max(0.001, da / (da + db))) : 0.5,
      point: { lat: c.aerodrome.lat, lng: c.aerodrome.lng, name: c.aerodrome.icao },
      stop: c,
    })
  }
  nodes.sort((x, y) => x.leg - y.leg || x.t - y.t)
  /** Route points the pilot already marked as fuel stops: hops end there. */
  const isRouteStop = (nd: Node) => nd.wp !== undefined && nd.wp > 0 && nd.wp < waypoints.length - 1 && waypoints[nd.wp].fuelStop === true
  const startIdx = nodes.findIndex(n => n.wp === 0)
  const endIdx   = nodes.findIndex(n => n.wp === waypoints.length - 1)

  // ── Hop between two nodes: its own fuel plan ────────────────────────────
  const hopCache = new Map<string, FuelStopHop | null>()
  function hop(u: number, v: number): FuelStopHop | null {
    const key = `${u}>${v}`
    const cached = hopCache.get(key)
    if (cached !== undefined) return cached
    const A = nodes[u], B = nodes[v]
    const pts: RouteWaypoint[] = [A.point]
    const legs: number[] = [A.leg]   // original leg of each hop leg
    const firstWp = A.wp !== undefined ? A.wp + 1 : A.leg + 1
    const lastWp  = B.wp !== undefined ? B.wp - 1 : B.leg
    for (let j = firstWp; j <= lastWp; j++) { pts.push(waypoints[j]); legs.push(j) }
    pts.push(B.point)
    legs.length = pts.length - 1
    const plan = computeFuelPlan(pts, legs.map(l => legOverrides[l] ?? {}), profile, legs.map(l => legWinds?.[l]))
    const ok = plan.enrouteMins > 0 && plan.totalMinFuelL <= hopLimitL
    const result = ok
      ? {
          from: A.stop ? A.stop.aerodrome.icao : label(A.point, A.wp ?? 0),
          to:   B.stop ? B.stop.aerodrome.icao : label(B.point, B.wp ?? 0),
          enrouteMins:  plan.enrouteMins,
          minFuelL:     plan.totalMinFuelL,
          landingFuelL: capacity - plan.taxiFuelL - plan.enrouteFuelL,
        }
      : null
    hopCache.set(key, result)
    return result
  }

  // ── Shortest path with a stop limit ─────────────────────────────────────
  // Nodes are in route order, so one pass in that order is enough (a DAG).
  function search(banned: ReadonlySet<string>): RankedPlan | null {
    const n = nodes.length
    const INF = Infinity
    // cost[s][i]: best cost reaching node i having used s stops.
    const cost = Array.from({ length: maxStops + 1 }, () => new Array<number>(n).fill(INF))
    const prev = Array.from({ length: maxStops + 1 }, () => new Array<[number, number] | null>(n).fill(null))
    cost[0][startIdx] = 0
    for (let i = startIdx; i < endIdx; i++) {
      for (let s = 0; s <= maxStops; s++) {
        if (cost[s][i] === INF) continue
        // From node i, jump to the next stop or straight to the destination.
        for (let j = i + 1; j <= endIdx; j++) {
          const nj = nodes[j]
          const routeStop = isRouteStop(nj)
          if (nj.stop && banned.has(nj.stop.aerodrome.icao)) continue
          if (!nj.stop && !routeStop && j !== endIdx) continue
          const s2 = nj.stop ? s + 1 : s
          if (s2 <= maxStops) {
            const h = hop(i, j)
            if (h) {
              const thin = Math.max(0, COMFORT_L - (capacity - h.minFuelL))
              const c = cost[s][i] + h.enrouteMins + BALANCE * h.enrouteMins * h.enrouteMins + thin + (nj.stop ? stopPenalty + rankPenalty * nj.stop.fuelRank : 0)
              if (c < cost[s2][j]) { cost[s2][j] = c; prev[s2][j] = [s, i] }
            }
          }
          // A hop cannot fly past a stop the pilot already planned.
          if (routeStop) break
        }
      }
    }
    let bestS = -1
    for (let s = 1; s <= maxStops; s++) {
      if (cost[s][endIdx] < INF && (bestS < 0 || cost[s][endIdx] < cost[bestS][endIdx])) bestS = s
    }
    if (bestS < 0) return null
    const path: number[] = []
    let cur: [number, number] | null = [bestS, endIdx]
    while (cur) { path.unshift(cur[1]); cur = prev[cur[0]][cur[1]] }
    const hops: FuelStopHop[] = []
    for (let k = 0; k < path.length - 1; k++) hops.push(hop(path[k], path[k + 1])!)
    const enrouteMins = hops.reduce((sum, h) => sum + h.enrouteMins, 0)
    return {
      stops: path.map(i => nodes[i].stop).filter((s): s is FuelStop => !!s),
      hops,
      enrouteMins,
      extraMins: Math.max(0, enrouteMins - tripMins),
      cost: cost[bestS][endIdx],
    }
  }

  const plans: RankedPlan[] = []
  const seen = new Set<string>()
  const add = (p: RankedPlan | null) => {
    if (!p) return
    const key = p.stops.map(s => s.aerodrome.icao).join(',')
    if (seen.has(key)) return
    seen.add(key)
    plans.push(p)
  }
  const best = search(new Set())
  add(best)
  if (best) {
    // Alternatives: leave out the best plan's stops one at a time, then all
    // stops found so far, until enough distinct plans are found.
    const banned = new Set<string>()
    for (let round = 0; round < maxPlans * 2 && plans.length < maxPlans; round++) {
      const last = plans[plans.length - 1]
      for (const s of last.stops) {
        if (plans.length >= maxPlans) break
        add(search(new Set([...banned, s.aerodrome.icao])))
      }
      for (const p of plans) for (const s of p.stops) banned.add(s.aerodrome.icao)
      const more = search(banned)
      if (!more) break
      add(more)
    }
  }
  plans.sort((a, b) => a.cost - b.cost)

  return plans.length > 0
    ? { status: 'found', plans: plans.slice(0, maxPlans).map(({ cost: _c, ...p }) => p), fuelTypesUnset }
    : { status: 'none-found', fuelTypesUnset, candidates: candidates.length }
}

/**
 * The route with a plan's stops inserted as fuel stops, as one new waypoint
 * and leg-override list (one edit, one undo step). The split leg's override
 * carries over to both halves, as when a point is inserted by hand.
 */
export function insertFuelStops(
  waypoints:    readonly RouteWaypoint[],
  legOverrides: readonly LegOverride[],
  plan:         Pick<FuelStopPlan, 'stops'>,
): { waypoints: RouteWaypoint[]; legOverrides: LegOverride[] } {
  const wps = [...waypoints]
  const ovr = waypoints.slice(0, -1).map((_, i) => legOverrides[i] ?? {})
  // Last stop first so earlier positions stay valid; stops on one leg end up in route order.
  for (const s of [...plan.stops].reverse()) {
    const at = s.insertAfter + 1
    wps.splice(at, 0, { lat: s.aerodrome.lat, lng: s.aerodrome.lng, name: s.aerodrome.icao, fuelStop: true })
    ovr.splice(at, 0, { ...(ovr[s.insertAfter] ?? {}) })
  }
  return { waypoints: wps, legOverrides: ovr }
}

/** The route with point `index` marked (or no longer marked) as a fuel stop. Ends are never stops. */
export function setFuelStop(waypoints: readonly RouteWaypoint[], index: number, on: boolean): RouteWaypoint[] {
  return waypoints.map((w, i) => {
    if (i !== index) return w
    const { fuelStop: _f, ...rest } = w
    return on && i > 0 && i < waypoints.length - 1 ? { ...rest, fuelStop: true } : rest
  })
}
