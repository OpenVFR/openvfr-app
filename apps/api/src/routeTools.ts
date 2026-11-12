/**
 * Routes written by the pilot's AI assistant (create_route / update_route):
 * input checking and the resulting route document, without I/O.
 *
 * Points are identifiers resolved against OpenVFR's aerodrome, navaid and
 * reporting-point data (or coordinates); nothing unknown or ambiguous is
 * guessed. Levels and speeds are bounded, fuel stops must be aerodromes on
 * the route, and the route is marked `assistantReview` so the app shows
 * "check before use" until the pilot saves it.
 */
import type { LegOverride, RouteDocType, RouteWaypoint } from '@open-vfr/shared/types'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { resolveRoutePoints, type PointIndex } from '@open-vfr/shared/routeIdentifiers'

export const MAX_POINTS = 30
export const ALT_LIMITS: [number, number] = [500, 20000]
export const SPEED_LIMITS: [number, number] = [30, 250]
/** Longer legs are kept but flagged: most likely a wrong identifier. */
const LONG_LEG_NM = 300

export interface RouteInput {
  name?: string
  /** Identifiers in flight order; on update, replaces the points. */
  points?: string[]
  /** Cruise altitude for every leg, ft. */
  altitudeFt?: number
  /** Per leg (1 = first point to second). */
  legs?: { leg: number; altitudeFt?: number; speedKts?: number }[]
  /** Points where the aircraft lands and refuels; replaces the current set. */
  fuelStops?: string[]
  /** aircraft_profile id ('' = none); undefined = unchanged. */
  aircraftId?: string
}

export class RouteInputError extends Error {}

export interface RouteBuild {
  doc: RouteDocType
  changed: string[]
  warnings: string[]
}

const norm = (s: string) => s.trim().toUpperCase()
const at = (w: RouteWaypoint) => `${norm(w.name ?? '')}@${w.lat.toFixed(4)},${w.lng.toFixed(4)}`
/**
 * One key per leg: both ends by name and position (points placed on the map
 * have no name), and the occurrence number when the same pair is flown more
 * than once, so every leg of a route has its own key.
 */
export function legKeys(waypoints: readonly RouteWaypoint[]): string[] {
  const seen = new Map<string, number>()
  return waypoints.slice(0, -1).map((w, i) => {
    const base = `${at(w)}>${at(waypoints[i + 1]!)}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return `${base}#${n}`
  })
}

export function buildRoute(input: RouteInput, ctx: { existing?: RouteDocType; idx: PointIndex; newId: string; by: string; now: number }): RouteBuild {
  const { existing } = ctx
  const changed: string[] = []
  const warnings: string[] = []

  // ── Points ──────────────────────────────────────────────────────────────
  let waypoints: RouteWaypoint[] = existing?.waypoints ?? []
  let legOverrides: LegOverride[] = existing?.legOverrides ?? []
  if (input.points) {
    const tokens = input.points.map(t => t.trim()).filter(Boolean)
    if (tokens.length < 2) throw new RouteInputError('A route needs at least 2 points.')
    if (tokens.length > MAX_POINTS) throw new RouteInputError(`At most ${MAX_POINTS} points.`)
    // Points already on the route are kept as they are (with their notes,
    // fuel-stop flags and positions the pilot may have placed by hand). A point is
    // the same when it is written as its stored name, or resolves to a point with that
    // name: PL/<place> and LM/<landmark> are stored under the plain name, a coordinate
    // under its formatted position.
    const keep = new Map((existing?.waypoints ?? []).filter(w => w.name).map(w => [norm(w.name!), w]))
    const resolved = resolveRoutePoints(tokens, ctx.idx)
    const errors: string[] = []
    const next: RouteWaypoint[] = tokens.map((t, i) => {
      const r = resolved[i]!
      const kept = keep.get(norm(t)) ?? (r.ok && r.point.name ? keep.get(norm(r.point.name)) : undefined)
      if (kept) return { ...kept }
      if (r.ok) return r.point
      errors.push(`${t}: ${r.reason}`)
      return { lat: 0, lng: 0 }
    })
    if (errors.length) throw new RouteInputError(`Not changed. Fix these points (use ICAO codes, navaid idents, AERODROME/POINT for reporting points, or coordinates like 5939N01756E): ${errors.join('; ')}.`)
    for (let i = 1; i < next.length; i++) {
      const d = distanceNm(next[i - 1]!, next[i]!)
      if (d < 0.05) throw new RouteInputError(`${next[i]!.name} follows itself; remove the repeated point.`)
      if (d > LONG_LEG_NM) warnings.push(`leg ${i} ${next[i - 1]!.name}→${next[i]!.name} is ${Math.round(d)} NM`)
    }
    // Leg settings stay with legs that keep both ends.
    const oldKeys = legKeys(waypoints)
    const oldLegs = new Map<string, LegOverride>(oldKeys.map((k, i) => [k, legOverrides[i] ?? {}]))
    legOverrides = legKeys(next).map(k => ({ ...(oldLegs.get(k) ?? {}) }))
    if (!existing || JSON.stringify(next) !== JSON.stringify(waypoints)) changed.push('points')
    waypoints = next
  }
  if (waypoints.length < 2) throw new RouteInputError('A route needs at least 2 points.')
  legOverrides = waypoints.slice(0, -1).map((_, i) => ({ ...(legOverrides[i] ?? {}) }))

  // ── Levels and speeds ───────────────────────────────────────────────────
  const inRange = (v: number, [lo, hi]: [number, number], what: string) => {
    if (!Number.isFinite(v) || v < lo || v > hi) throw new RouteInputError(`${what} must be ${lo} to ${hi}.`)
    return Math.round(v)
  }
  const before = JSON.stringify(legOverrides)
  if (input.altitudeFt !== undefined) {
    const alt = inRange(input.altitudeFt, ALT_LIMITS, 'altitudeFt (ft)')
    legOverrides = legOverrides.map(o => ({ ...o, altFt: alt }))
  }
  for (const l of input.legs ?? []) {
    if (!Number.isInteger(l.leg) || l.leg < 1 || l.leg > legOverrides.length) throw new RouteInputError(`leg ${l.leg} does not exist: legs are 1 to ${legOverrides.length}.`)
    const o = { ...legOverrides[l.leg - 1] }
    if (l.altitudeFt !== undefined) o.altFt = inRange(l.altitudeFt, ALT_LIMITS, `leg ${l.leg} altitudeFt (ft)`)
    if (l.speedKts !== undefined) o.speedKts = inRange(l.speedKts, SPEED_LIMITS, `leg ${l.leg} speedKts (kt IAS)`)
    legOverrides[l.leg - 1] = o
  }
  if (JSON.stringify(legOverrides) !== before) changed.push('levels')

  // ── Fuel stops: aerodromes between the first and last point ──────────────
  if (input.fuelStops) {
    const want = new Set(input.fuelStops.map(norm))
    const inner = waypoints.slice(1, -1)
    for (const s of want) {
      const w = inner.find(p => norm(p.name ?? '') === s)
      if (!w) throw new RouteInputError(`Fuel stop ${s} is not a point between departure and destination.`)
      if (w.elevationFt === undefined && !/^[A-Z]{2}[A-Z0-9]{2}$/.test(s)) throw new RouteInputError(`Fuel stop ${s} is not an aerodrome.`)
    }
    const next = waypoints.map((w, i) => {
      const stop = i > 0 && i < waypoints.length - 1 && want.has(norm(w.name ?? ''))
      const { fuelStop: _f, ...rest } = w
      return stop ? { ...rest, fuelStop: true } : rest
    })
    if (JSON.stringify(next) !== JSON.stringify(waypoints)) changed.push('fuel stops')
    waypoints = next
  }

  // ── Name and aircraft ───────────────────────────────────────────────────
  let name = existing?.name ?? ''
  if (input.name !== undefined) {
    const n = input.name.replace(/\s+/g, ' ').trim()
    if (!n || n.length > 80) throw new RouteInputError('name must be 1 to 80 characters.')
    if (n !== name) changed.push('name')
    name = n
  }
  if (!name) name = `${waypoints[0]!.name ?? 'Start'} – ${waypoints[waypoints.length - 1]!.name ?? 'End'}`
  let aircraftId = existing?.aircraftId ?? ''
  if (input.aircraftId !== undefined && input.aircraftId !== aircraftId) {
    aircraftId = input.aircraftId
    changed.push('aircraft')
  }

  const prev = existing?.assistantReview
  const change: 'created' | string[] = !existing || prev?.change === 'created'
    ? 'created'
    : [...new Set([...(Array.isArray(prev?.change) ? prev.change : []), ...changed])]
  const doc: RouteDocType = {
    id: existing?.id ?? ctx.newId,
    name, waypoints, legOverrides, aircraftId,
    assistantReview: { by: ctx.by, at: ctx.now, change },
    updatedAt: ctx.now,
  }
  return { doc, changed: existing ? changed : ['created'], warnings }
}

/**
 * Indices of legs whose planned altitude this change set or changed (new
 * legs, or an altitude different from the same leg before). Levels the pilot
 * already accepted are not asked about again.
 */
export function changedLevelLegs(existing: RouteDocType | undefined, doc: RouteDocType): number[] {
  const before = new Map<string, number | undefined>()
  if (existing) legKeys(existing.waypoints).forEach((k, i) => before.set(k, existing.legOverrides[i]?.altFt))
  const keys = legKeys(doc.waypoints)
  const out: number[] = []
  for (let i = 0; i < doc.waypoints.length - 1; i++) {
    const alt = doc.legOverrides[i]?.altFt
    if (alt === undefined) continue
    const key = keys[i]!
    if (!before.has(key) || before.get(key) !== alt) out.push(i)
  }
  return out
}

/** One line per leg for an answer: "1. ESSB → ESSA 18 NM, 2500 ft". */
export function legLines(r: RouteDocType, fmtName: (name: string) => string = n => n): string[] {
  return r.waypoints.slice(0, -1).map((w, i) => {
    const to = r.waypoints[i + 1]!
    const o = r.legOverrides[i] ?? {}
    return `${i + 1}. ${fmtName(w.name ?? `WP${i + 1}`)} → ${fmtName(to.name ?? `WP${i + 2}`)}${to.fuelStop ? ' (fuel stop)' : ''} ${Math.round(distanceNm(w, to))} NM` +
      `${o.altFt ? `, ${o.altFt} ft` : ', default altitude'}${o.speedKts ? `, ${o.speedKts} kt` : ''}`
  })
}
