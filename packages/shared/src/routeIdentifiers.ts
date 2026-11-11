/**
 * Resolve route point identifiers against the aerodrome, navaid, waypoint
 * and landmark data: "ESSB", "ARL", "ESNV/NORTH", "LM/Hassela kyrka",
 * "5939N01756E". Landmarks are the named ones only (churches, water towers,
 * windmills...), written LM/<name>.
 *
 * Reporting points repeat between aerodromes (NORTH exists at several), so a
 * bare name is resolved to the copy that belongs to an aerodrome named in
 * the same route; otherwise "AERODROME/POINT" is needed and the error lists
 * the choices. Nothing unknown or ambiguous is guessed.
 */
import { parseCoordinate } from './coordinateParse'
import type { RouteWaypoint } from './routeCalc'

type FC = { features: { geometry: { type?: string; coordinates: unknown } | null; properties: Record<string, unknown> | null }[] }

export interface IndexedPoint {
  kind: 'aerodrome' | 'navaid' | 'waypoint' | 'landmark'
  id: string
  name: string
  lat: number
  lng: number
  elevationFt?: number
  /** Aerodrome a reporting point belongs to. */
  aerodrome?: string
}

export interface PointIndex {
  aerodromes: Map<string, IndexedPoint>
  navaids: Map<string, IndexedPoint[]>
  waypoints: Map<string, IndexedPoint[]>
  /** Named landmarks by upper-case name. */
  landmarks: Map<string, IndexedPoint[]>
}

function coords(f: FC['features'][number]): [number, number] | null {
  const c = f.geometry?.coordinates
  return Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' ? [c[0], c[1]] : null
}

const push = (m: Map<string, IndexedPoint[]>, k: string, p: IndexedPoint) => { const l = m.get(k); if (l) l.push(p); else m.set(k, [p]) }

export function buildPointIndex(sets: { aerodromes?: FC | null; navaids?: FC | null; waypoints?: FC | null; landmarks?: FC | null }): PointIndex {
  const idx: PointIndex = { aerodromes: new Map(), navaids: new Map(), waypoints: new Map(), landmarks: new Map() }
  for (const f of sets.aerodromes?.features ?? []) {
    const c = coords(f); const p = f.properties ?? {}
    const icao = String(p['icao'] ?? '').toUpperCase()
    if (!c || !icao) continue
    idx.aerodromes.set(icao, { kind: 'aerodrome', id: icao, name: String(p['name'] ?? icao), lng: c[0], lat: c[1], elevationFt: Number(p['elevation_ft'] ?? 0) || 0 })
  }
  for (const f of sets.navaids?.features ?? []) {
    const c = coords(f); const p = f.properties ?? {}
    const id = String(p['id'] ?? '').toUpperCase()
    if (c && id) push(idx.navaids, id, { kind: 'navaid', id, name: String(p['name'] ?? id), lng: c[0], lat: c[1] })
  }
  for (const f of sets.waypoints?.features ?? []) {
    const c = coords(f); const p = f.properties ?? {}
    const id = String(p['id'] ?? '').toUpperCase()
    const ad = String(p['aerodrome'] ?? '').toUpperCase() || undefined
    if (c && id) push(idx.waypoints, id, { kind: 'waypoint', id, name: String(p['name'] ?? id), lng: c[0], lat: c[1], aerodrome: ad })
  }
  for (const f of sets.landmarks?.features ?? []) {
    const c = coords(f); const p = f.properties ?? {}
    const name = String(p['name'] ?? '').trim()
    if (c && name) push(idx.landmarks, name.toUpperCase(), { kind: 'landmark', id: name, name: String(p['kind'] ?? 'landmark'), lng: c[0], lat: c[1] })
  }
  return idx
}

/** The identifier to write a point with in a route (what resolveRoutePoints accepts). */
export function routeIdentifier(p: IndexedPoint): string {
  return p.kind === 'waypoint' && p.aerodrome ? `${p.aerodrome}/${p.id}` : p.kind === 'landmark' ? `LM/${p.id}` : p.id
}

export type Resolved = { ok: true; point: RouteWaypoint } | { ok: false; token: string; reason: string }

/** Degrees-minutes coordinate a route accepts, e.g. 5939N01756E. */
export function fmtCoord(lat: number, lng: number): string {
  const dm = (v: number, w: number) => {
    const a = Math.abs(v), d = Math.floor(a), m = Math.round((a - d) * 60)
    return m === 60 ? `${String(d + 1).padStart(w, '0')}00` : `${String(d).padStart(w, '0')}${String(m).padStart(2, '0')}`
  }
  return `${dm(lat, 2)}${lat >= 0 ? 'N' : 'S'}${dm(lng, 3)}${lng >= 0 ? 'E' : 'W'}`
}

function toWaypoint(p: IndexedPoint): RouteWaypoint {
  const name = p.kind === 'waypoint' && p.aerodrome ? `${p.aerodrome}/${p.id}` : p.id
  return { lat: p.lat, lng: p.lng, name, ...(p.kind === 'aerodrome' ? { elevationFt: p.elevationFt } : {}) }
}

/**
 * Resolve every token of a route. `routeAerodromes` (ICAO codes in the same
 * route) settles which copy of a repeated reporting point is meant.
 */
export function resolveRoutePoints(tokens: readonly string[], idx: PointIndex): Resolved[] {
  const clean = tokens.map(t => t.trim().toUpperCase()).filter(Boolean)
  const routeAerodromes = new Set(clean.filter(t => idx.aerodromes.has(t)))
  return clean.map((token): Resolved => {
    const ad = idx.aerodromes.get(token)
    if (ad) return { ok: true, point: toWaypoint(ad) }

    // LM/<name>: a named landmark; the same name in several places needs coordinates.
    const lm = /^LM\/(.+)$/.exec(token)
    if (lm) {
      const hits = idx.landmarks.get(lm[1]!.trim()) ?? []
      if (hits.length === 1) return { ok: true, point: toWaypoint(hits[0]!) }
      if (hits.length > 1) return { ok: false, token, reason: `${hits.length} landmarks have this name; use the coordinates of the one you mean: ${hits.slice(0, 5).map(h => fmtCoord(h.lat, h.lng)).join(', ')}` }
      return { ok: false, token, reason: 'no named landmark with this name in OpenVFR\'s data' }
    }

    // AERODROME/POINT: a reporting point of that aerodrome.
    const slash = /^([A-Z]{4})\/(.+)$/.exec(token)
    if (slash) {
      const hit = (idx.waypoints.get(slash[2]!) ?? []).find(w => w.aerodrome === slash[1])
      return hit ? { ok: true, point: toWaypoint(hit) } : { ok: false, token, reason: `no reporting point ${slash[2]} at ${slash[1]}` }
    }

    const nav = idx.navaids.get(token) ?? []
    const wps = idx.waypoints.get(token) ?? []
    const candidates = [...nav, ...wps]
    if (candidates.length === 1) return { ok: true, point: toWaypoint(candidates[0]!) }
    if (candidates.length > 1) {
      const local = wps.filter(w => w.aerodrome && routeAerodromes.has(w.aerodrome))
      if (nav.length === 0 && local.length === 1) return { ok: true, point: toWaypoint(local[0]!) }
      const options = candidates.map(c => (c.kind === 'navaid' ? `${c.id} (navaid ${c.name})` : `${c.aerodrome}/${c.id}`)).slice(0, 8)
      return { ok: false, token, reason: `ambiguous, write one of: ${options.join(', ')}` }
    }

    const c = parseCoordinate(token)
    if (c) return { ok: true, point: { lat: c.lat, lng: c.lng, name: `${Math.abs(c.lat).toFixed(4)}${c.lat >= 0 ? 'N' : 'S'} ${Math.abs(c.lng).toFixed(4)}${c.lng >= 0 ? 'E' : 'W'}` } }
    return { ok: false, token, reason: 'not an aerodrome, navaid, reporting point or coordinate in OpenVFR\'s data' }
  })
}
