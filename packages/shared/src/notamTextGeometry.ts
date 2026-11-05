/**
 * notamTextGeometry.ts -- the area a NOTAM's free text (item E) describes.
 *
 * The NOTAM header (Q-line) only gives a centre and a radius in whole NM:
 * a coarse envelope around the real subject. Many NOTAMs describe the real
 * area in item E, and NMS-API returns no geometry beyond that Q-line point
 * (measured: every record's geometry is a GeometryCollection with one
 * Point). Example: a German NVG-training NOTAM's Q-line is an 85 NM circle
 * that covers southern Skane, while its text lists a polygon in German
 * coastal waters that stays ~25 NM from Sweden.
 *
 * Extracted, in order of preference:
 *   1. polygons: a run of >= 3 coordinates joined by "-" / "," that is an
 *      area (introduced by WITHIN / BOUNDED BY / AREA ..., or closed on its
 *      first vertex, or ending "point of origin"); a run without either is a
 *      list of points (obstacles, a route) and stays out. Edges can be arcs
 *      ("CLOCKWISE ARC RADIUS r CENTRED ON c TO": densified, and dropped
 *      when the stated radius disagrees with the real distance) and
 *      "ALONG THE STATE BORDER / COASTLINE TO" links (drawn as straight
 *      edges for now). Several rings -> MultiPolygon;
 *   2. a single circle: "<r> NM RADIUS OF/CENTRED ON <coord>",
 *      "RADIUS <r> NM CENTRED ON <coord>", "<coord> RADIUS <r> NM", ... A
 *      circle introduced by EXCLUDING / EXCEPT is a cut-out, reported in
 *      `excluded`, not a second area;
 *   3. a precise point: "PSN <coord>" (obstacles; the Q-line centre is
 *      rounded to whole minutes, ~1 NM).
 * Not handled (Q-line circle stays): lines between two points, areas named
 * only by designator.
 *
 * Every result is sanity-checked against the Q-line circle so a stray
 * coordinate in the text (a reference point, a phone-number-like token)
 * can never move a NOTAM somewhere unrelated.
 */
import type { NotamPolygonGeometry } from './notamCoverageArea'
import { findCoordinates, formatCoordinate } from './coordinateParse'

export interface TextCircle { lat: number; lon: number; radiusNm: number }
export interface TextPoint  { lat: number; lon: number }

export interface NotamTextGeometry {
  polygon: NotamPolygonGeometry | null
  circle: TextCircle | null
  point: TextPoint | null
  /** Circles cut out of the area ("EXCLUDING 1 NM RADIUS OF ..."); not drawn as areas. */
  excluded?: TextCircle[]
  /** Why no geometry came out of text that looked like it had some; absent when there was nothing to find. */
  reason?: NotamTextReason
}

/**
 * Typed reasons for an empty result (a Q-line circle is used instead):
 *   unclosed          a coordinate run with no area phrase and no closing vertex
 *   arc-radius-mismatch  an arc's stated radius disagrees with its centre
 *   border-unresolved a border edge could not be followed (reserved: border edges are still drawn straight)
 *   outside-qline     every shape lies far outside the Q-line circle
 *   multiple-radii    several radii around one centre: no way to tell which is the area
 *   self-intersecting every ring crosses itself
 */
export type NotamTextReason =
  | 'unclosed' | 'arc-radius-mismatch' | 'border-unresolved' | 'outside-qline' | 'multiple-radii' | 'self-intersecting'

/** True when a closed [lon, lat] ring crosses itself (edges sharing an end vertex don't count). */
export function ringSelfIntersects(ring: number[][]): boolean {
  const n = ring.length - 1 // closing vertex repeats the first
  if (n < 4) return false
  const cross = (a: number[], b: number[], c: number[]) => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[i + 1]!
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // adjacent through the closing vertex
      const c = ring[j]!, d = ring[j + 1]!
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
      if (d1 * d2 < 0 && d3 * d4 < 0) return true
    }
  }
  return false
}

// Distance units: NM, NAUTICAL MILE(S), KM, KILOMETRE(S)/KILOMETER(S), M,
// METRE(S)/METER(S), SM, STATUTE MILE(S). Only ever read next to a RADIUS /
// AROUND / CENTRED keyword, so a bare "M" is never taken for a distance on its own.
const UNIT = String.raw`(\d+(?:[.,]\d+)?)\s?(NAUTICAL\s+MILES?|NM|KILOMET(?:RE|ER)S?|KM|STATUTE\s+MILES?|SM|METRES?|METERS?|M)\b`
// Optional word before a coordinate: PSN, POSN, POSITION, POINT, COORD(INATES), with ":".
const KW = String.raw`(?:(?:PSN|POSN|POSITION|POINT|COORD(?:INATES)?)\s*:?\s*)?`

interface Coord { lat: number; lon: number; start: number; end: number }

function plausible(lat: number, lon: number): boolean {
  // Upper latitude reaches Svalbard (~80N).
  return lat >= 25 && lat <= 82 && lon >= -35 && lon <= 50
}

/**
 * Line breaks in NMS text are raw "\r"/"\n" and can fall inside a
 * coordinate ("545000N010000\n0E"): between two digits they are dropped,
 * anywhere else they become a space (so words stay apart: "WITH\nCENTRE").
 * Upper-cased for the keyword patterns.
 */
export function normalizeNotamText(text: string): string {
  return text.replace(/(\d)[\r\n]+(\d)/g, '$1$2').replace(/[\r\n]+/g, ' ').toUpperCase()
}

/**
 * Coordinates of a normalised text, found by the shared scanner
 * (`findCoordinates`: every notation, minutes/seconds range-checked, each
 * rejected on its own), minus positions outside the plausibility box.
 */
function coords(t: string): Coord[] {
  return findCoordinates(t)
    .filter(c => plausible(c.lat, c.lng))
    .map(c => ({ lat: c.lat, lon: c.lng, start: c.start, end: c.end }))
}

/**
 * Replace each coordinate by a "\u0001<n>\u0002" token so the circle / arc
 * patterns can name "a coordinate" without repeating a notation: one
 * scanner, many patterns. `cs[n]` is the coordinate behind token n.
 */
const TOK = String.raw`\u0001(\d+)\u0002`
function maskCoords(t: string, cs: Coord[]): { masked: string; cs: Coord[] } {
  let masked = ''
  let at = 0
  cs.forEach((c, i) => { masked += t.slice(at, c.start) + `\u0001${i}\u0002`; at = c.end })
  masked += t.slice(at)
  // Positions in the masked text (what the clause patterns report).
  const pos = [...masked.matchAll(new RegExp(TOK, 'g'))]
    .map(m => ({ ...cs[Number(m[1])]!, start: m.index!, end: m.index! + m[0].length }))
  return { masked, cs: pos }
}

// Boundary segment along an arc, between two vertices. The radius may come
// before or after the centre, or be missing; "ALONG" is optional:
//   A ALONG A (COUNTER/ANTI-)CLOCKWISE ARC (RADIUS 8NM WITH CENTRE <c>) TO B
//   A - CLOCKWISE ARC OF A CIRCLE CENTRED ON <c> RADIUS 5 NM TO B
const ARC_DIR = String.raw`(?:ALONG\s+)?(?:AN?\s+|THE\s+)?(CLOCKWISE|COUNTER[- ]?CLOCKWISE|ANTI[- ]?CLOCKWISE)\s+ARC(?:\s+OF\s+(?:A\s+)?CIRCLE)?`
const ARC_RADIUS = String.raw`(?:WITH\s+)?(?:A\s+)?RADIUS\s+(?:OF\s+)?${UNIT}`
const ARC_CENTRE = String.raw`(?:WITH\s+)?(?:CENTRE|CENTER|CENTRED|CENTERED)\s*(?:AT|ON)?\s*${TOK}`
const ARC = new RegExp(
  // groups: 1 direction | radius first: 2 value, 3 unit, 4 token | centre first: 5 token, 6 value, 7 unit
  String.raw`${ARC_DIR}\s*\(?\s*(?:${ARC_RADIUS}\s*,?\s*${ARC_CENTRE}|${ARC_CENTRE}\s*,?\s*(?:${ARC_RADIUS})?)\s*\)?\s*TO`,
  'g',
)

const BORDER_LINK = /^\s*[-\u2013,]?\s*(?:THEN\s+)?(?:ALONG\s+(?:THE\s+)?)?(?:[A-Z]+\s+)?(?:STATE|NATIONAL|INTERNATIONAL|COUNTRY|FIR)?\s*(?:BORDER|BOUNDARY|BDRY|COASTLINE|COAST)(?:\s+LINE)?(?:\s+OF\s+[A-Z]{1,20})?\s*(?:TO\s+)?(?:POINT\s*)?[-\u2013,]?\s*$/

interface ArcClause { start: number; end: number; clockwise: boolean; lat: number; lon: number; radiusNm: number | null }

function arcClauses(t: string, cs: Coord[]): ArcClause[] {
  const out: ArcClause[] = []
  for (const m of t.matchAll(ARC)) {
    // Radius first (groups 2-4) or centre first (groups 5-7).
    const tok = m[4] ?? m[5]
    const c = cs[Number(tok)]!
    const [v, u] = m[4] !== undefined ? [m[2], m[3]] : [m[6], m[7]]
    out.push({
      start: m.index!, end: m.index! + m[0].length,
      clockwise: m[1] === 'CLOCKWISE', lat: c.lat, lon: c.lon,
      radiusNm: v && u ? toNm(v, u) : null,
    })
  }
  return out
}

/** Points along an arc from a to b around centre c (exclusive of a and b), every ~10 deg. */
function arcPoints(a: Coord, b: Coord, c: ArcClause): number[][] {
  const kx = Math.cos(c.lat * Math.PI / 180)
  const bearing = (p: { lat: number; lon: number }) => Math.atan2((p.lon - c.lon) * kx, p.lat - c.lat)
  const r = (p: { lat: number; lon: number }) => Math.hypot((p.lon - c.lon) * kx, p.lat - c.lat)
  const a0 = bearing(a), a1 = bearing(b)
  const rad = (r(a) + r(b)) / 2
  let sweep = a1 - a0
  if (c.clockwise) { while (sweep <= 0) sweep += 2 * Math.PI } else { while (sweep >= 0) sweep -= 2 * Math.PI }
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 18)))
  const pts: number[][] = []
  for (let i = 1; i < steps; i++) {
    const th = a0 + (sweep * i) / steps
    pts.push([c.lon + (rad * Math.sin(th)) / kx, c.lat + rad * Math.cos(th)])
  }
  return pts
}

// An open run of vertices is a ring only after one of these ("WITHIN <c> - <c> - <c>",
// "AREA: ...", "BOUNDED BY ...", "LATERAL LIMITS ...", "THE FOLLOWING POINTS ...").
// Without one -- or a closing vertex -- a coordinate list is a list of points
// (an obstacle list, a route), not an area.
const AREA_INTENT = /\b(?:WITHIN|WI|BOUNDED\s+BY|ENCLOSED\s+BY|DEFINED\s+BY|LATERAL\s+LIMITS?|AREA|(?:THE\s+)?FOLLOWING\s+(?:POINTS|COORDINATES)|AS\s+FOLLOWS?)\b/
// After the last vertex: "TO THE POINT OF ORIGIN" closes the ring explicitly.
const ORIGIN_AFTER = /^\s*[-\u2013,;]?\s*(?:TO\s+(?:THE\s+)?)?(?:POINT\s+OF\s+ORIGIN|ORIGIN|START(?:ING)?\s+POINT)\b/

/** Largest accepted gap between an arc's stated radius and the real distance to its centre. */
const ARC_RADIUS_TOLERANCE_NM = 1

const sameVertex = (a: Coord, b: Coord) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5

interface Rings { rings: number[][][]; unclosed: number; arcMismatch: boolean; arcs: ArcClause[] }

function polygons(t: string, all: Coord[]): Rings {
  const arcs = arcClauses(t, all)
  // An arc's centre is not a boundary vertex.
  const cs = all.filter(c => !arcs.some(a => c.start >= a.start && c.end <= a.end))
  const rings: number[][][] = []
  let unclosed = 0
  let arcMismatch = false
  let ring: number[][] = []
  let vertices = 0
  let first: Coord | null = null
  let prev: Coord | null = null
  let before = 0 // end of the coordinate before the run's first one
  let intent = false
  const flush = (closed: boolean) => {
    // Distinct vertices: a closing repeat of the first does not count.
    const distinct = closed ? vertices - 1 : vertices
    if (distinct >= 3 && ring.length >= 3) {
      const open = !closed && !intent && !(prev && ORIGIN_AFTER.test(t.slice(prev.end, prev.end + 60)))
      if (open) {
        unclosed++
      } else {
        const [f, l] = [ring[0]!, ring[ring.length - 1]!]
        if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0]!, f[1]!])
        rings.push(ring)
      }
    }
    ring = []; vertices = 0; first = null; prev = null
  }
  let lastEnd = 0
  for (const c of cs) {
    if (prev) {
      // Commentary between vertices -- "(0.7NM E MESTO ...)" reference
      // points, repeated "PSN" labels -- does not break the boundary.
      const gap = t.slice(prev.end, c.start)
        .replace(/\([^()]*\)/g, ' ').replace(/\b(?:PSN|POSN|POINT)\b\s*:?/g, ' ')
      const arc = arcs.find(a => a.start >= prev!.end && a.end <= c.start)
      if (arc && /^\s*[-\u2013,]?\s*$/.test(t.slice(prev.end, arc.start)) && /^\s*$/.test(t.slice(arc.end, c.start))) {
        // The stated radius must match the real distance from both ends to
        // the centre; a miss of more than ~1 NM means a wrong centre (or
        // radius) and the shape cannot be trusted.
        if (arc.radiusNm !== null && [prev, c].some(p => Math.abs(distNm(p.lat, p.lon, arc.lat, arc.lon) - arc.radiusNm!) > ARC_RADIUS_TOLERANCE_NM)) arcMismatch = true
        ring.push(...arcPoints(prev, c, arc))
      } else if (/^\s*BACK\s+TO\s*$/.test(gap) && first) {
        ring.push([c.lon, c.lat]); vertices++; prev = c
        flush(true); lastEnd = c.end; continue // closed explicitly
      } else if (!/^\s*[-\u2013,;]?\s*(?:\d{1,2}\s*[.):]\s*)?$/.test(gap) && !BORDER_LINK.test(gap)) {
        // continues on "-", ",", whitespace, numbered lists ("1. c 2. c")
        // and "STATE BORDER" / "ALONG THE COASTLINE TO" links (drawn
        // straight -- coarser than the real border, still the right area)
        flush(false)
      }
    }
    if (!first) {
      first = c
      before = lastEnd
      intent = AREA_INTENT.test(t.slice(Math.max(before, c.start - 80), c.start))
    }
    ring.push([c.lon, c.lat]); vertices++
    prev = c
    lastEnd = c.end
    // Back on the first vertex: this ring is done, even when only dashes
    // separate it from the next one.
    if (vertices > 1 && sameVertex(first, c)) flush(true)
  }
  flush(false)
  return { rings, unclosed, arcMismatch, arcs }
}

function toNm(value: string, unit: string): number {
  const v = Number(value.replace(',', '.'))
  if (/^(?:NM|NAUTICAL)/.test(unit)) return v
  if (/^(?:KM|KILOMET)/.test(unit)) return v / 1.852
  if (/^(?:SM|STATUTE)/.test(unit)) return (v * 1609.344) / 1852
  return v / 1852
}

const CENTRE = String.raw`(?:CENTRED|CENTERED|CENTRE|CENTER)(?:\s+(?:ON|AT))?`
// Each pattern: capture groups (value, unit, token).
const CIRCLE_PATTERNS: RegExp[] = [
  // 0.5NM RADIUS OF <c> / 1NM RADIUS CENTERED ON <c> / 2 KM RADIUS AROUND PSN <c>
  // / 1050M RADIUS CENTERED ON COORD: <c> / 300M (0.16NM) RADIUS CENTRED ON <c>
  new RegExp(String.raw`${UNIT}\s*(?:\([^)]{0,20}\))?\s+RADIUS\s+(?:OF\s+|AROUND\s+|${CENTRE}\s+)?${KW}${TOK}`, 'g'),
  // RADIUS (OF) 1.5NM CENTERED ON <c> / CIRCLE RADIUS 2NM CENTERED ON POINT <c>
  new RegExp(String.raw`RADIUS\s+(?:OF\s+)?${UNIT}\s*,?\s*(?:WITH\s+)?(?:${CENTRE}|AROUND)\s*${KW}${TOK}`, 'g'),
  // 1NM AROUND <c> / WI 2.5NM OF PSN <c>
  new RegExp(String.raw`${UNIT}\s+(?:AROUND|OF|${CENTRE})\s+${KW}${TOK}`, 'g'),
]
// <c> RADIUS 2NM / PSN <c> WITH A RADIUS OF 500M / PSN <c> RADIUS 0,25NM (coordinate first)
const CIRCLE_COORD_FIRST = new RegExp(String.raw`${TOK}\s*(?:\([^)]{0,80}\))?\s*,?\s*(?:WITH\s+)?(?:A\s+)?(?:RADIUS|RAD)\s+(?:OF\s+)?(?:UP\s+TO\s+)?${UNIT}`, 'g')

// A circle introduced by one of these is cut out of the area, not a second area:
// "5 NM RADIUS OF A, EXCLUDING 1 NM RADIUS OF B".
const EXCLUDE_BEFORE = /(?:EXCLUDING|EXCLUDE|EXCEPT(?:ING)?|NOT\s+INCLUDING|EXCL)\W*(?:(?:THE|AN?)\s+)?(?:AREA\s+)?(?:WITHIN\s+)?$/

/** Circles in the text: `main` are areas, `excluded` are cut-outs of them. */
/** Text with the arc clauses blanked: their radius/centre are not circles. */
function withoutArcs(t: string, arcs: ArcClause[]): string {
  let out = ''
  let at = 0
  for (const a of arcs) { out += t.slice(at, a.start) + ' ARC '; at = a.end }
  return out + t.slice(at)
}

function circles(t: string, cs: Coord[]): { main: TextCircle[]; excluded: TextCircle[] } {
  const main: TextCircle[] = []
  const excluded: TextCircle[] = []
  const add = (index: number, c: Coord, radiusNm: number) => {
    const circle = { lat: c.lat, lon: c.lon, radiusNm }
    ;(EXCLUDE_BEFORE.test(t.slice(Math.max(0, index - 40), index)) ? excluded : main).push(circle)
  }
  for (const re of CIRCLE_PATTERNS) {
    for (const m of t.matchAll(re)) add(m.index!, cs[Number(m[3])]!, toNm(m[1]!, m[2]!))
  }
  for (const m of t.matchAll(CIRCLE_COORD_FIRST)) add(m.index!, cs[Number(m[1])]!, toNm(m[2]!, m[3]!))
  const uniq = (list: TextCircle[]) => [...new Map(list.filter(c => plausible(c.lat, c.lon) && c.radiusNm > 0 && c.radiusNm <= 200)
    .map(c => [`${c.lat.toFixed(4)},${c.lon.toFixed(4)},${c.radiusNm.toFixed(3)}`, c])).values()]
  return { main: uniq(main), excluded: uniq(excluded) }
}

const PSN = new RegExp(String.raw`\b(?:PSN|POSN|POSITION)\s*:?\s*${TOK}`, 'g')

function points(t: string, cs: Coord[]): TextPoint[] {
  const uniq = new Map<string, TextPoint>()
  for (const m of t.matchAll(PSN)) {
    const c = cs[Number(m[1])]!
    const p = { lat: c.lat, lon: c.lon }
    if (plausible(p.lat, p.lon)) uniq.set(`${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, p)
  }
  return [...uniq.values()]
}

/** 36-segment ring for a circle ([lon, lat], closed). */
function circleRing(c: TextCircle): number[][] {
  const kx = Math.cos(c.lat * Math.PI / 180)
  const r = c.radiusNm / 60
  const ring: number[][] = []
  for (let i = 0; i <= 36; i++) {
    const a = (i / 36) * 2 * Math.PI
    ring.push([c.lon + (r * Math.sin(a)) / kx, c.lat + r * Math.cos(a)])
  }
  return ring
}

function distNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const kx = 60 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180)
  return Math.hypot((aLat - bLat) * 60, (aLon - bLon) * kx)
}

/**
 * Area described in the NOTAM text, checked against the Q-line circle
 * (`qLat/qLon/qRadiusNm`, when known and not the 999 NM whole-FIR
 * sentinel): every vertex / the circle centre / the point must lie within
 * the Q radius plus a tolerance (Q coordinates are rounded to whole minutes
 * and radii are rounded up).
 */
export function notamTextGeometry(
  text: string | null | undefined,
  q?: { lat: number; lon: number; radiusNm: number | null } | null,
): NotamTextGeometry {
  const none: NotamTextGeometry = { polygon: null, circle: null, point: null }
  if (!text) return none
  const t = normalizeNotamText(text)
  const checkQ = q && q.radiusNm !== null && q.radiusNm > 0 && q.radiusNm < 999
  // Generous: Q-lines are sometimes plainly off (seen: 40 NM for a 1 NM
  // area); the check only has to stop a coordinate from another region.
  const tol = (r: number) => r * 1.5 + 50
  const inQ = (lat: number, lon: number) =>
    !checkQ || distNm(lat, lon, q.lat, q.lon) <= tol(q.radiusNm!)

  const found = coords(t)
  const { masked: mt, cs } = maskCoords(t, found)
  const poly = polygons(mt, cs)
  // A wrong arc centre/radius: no text geometry at all (the Q-line circle stays),
  // and the arc's own "RADIUS r CENTRED ON c" must not be read as a circle.
  if (poly.arcMismatch) return { ...none, reason: 'arc-radius-mismatch' }
  // First thing that went wrong, reported if nothing else is found.
  let reason: NotamTextReason | undefined
  const simple = poly.rings.filter(r => !ringSelfIntersects(r))
  if (poly.rings.length > 0 && simple.length === 0) reason = 'self-intersecting'
  const rings = simple.filter(r => r.every(([lon, lat]) => inQ(lat!, lon!)))
  if (simple.length > 0 && rings.length === 0) reason ??= 'outside-qline'
  if (rings.length === 0 && poly.unclosed > 0) reason ??= 'unclosed'
  if (rings.length === 1) return { ...none, polygon: { type: 'Polygon', coordinates: [rings[0]!] } }
  if (rings.length > 1) return { ...none, polygon: { type: 'MultiPolygon', coordinates: rings.map(r => [r]) } }

  const { main, excluded } = circles(withoutArcs(mt, poly.arcs), cs)
  const cc = main.filter(c => inQ(c.lat, c.lon))
  if (main.length > 0 && cc.length === 0) reason ??= 'outside-qline'
  if (cc.length === 1) return { ...none, circle: cc[0]!, ...(excluded.length ? { excluded } : {}) }
  if (cc.length > 1) {
    // Several radii around one centre cannot be told apart (inner zone? outer
    // envelope?): refuse rather than draw nested copies.
    const [c0] = cc
    if (cc.every(c => Math.abs(c.lat - c0!.lat) < 1e-4 && Math.abs(c.lon - c0!.lon) < 1e-4)) return { ...none, reason: 'multiple-radii' }
    // Several areas ("AREA 1: 1.45KM RADIUS OF ..., AREA 2: ..."): one polygon each.
    return { ...none, polygon: { type: 'MultiPolygon', coordinates: cc.map(c => [circleRing(c)]) } }
  }

  const allPs = points(mt, cs)
  const ps = allPs.filter(p => inQ(p.lat, p.lon))
  if (allPs.length > 0 && ps.length === 0) reason ??= 'outside-qline'
  if (ps.length === 1) return { ...none, point: ps[0]! }
  if (ps.length > 1) return reason ? { ...none, reason } : none
  // A single bare coordinate in the whole text ("CAPTIVE BALLOON: c",
  // "LASER: c") is the subject's position.
  if (cs.length === 1) {
    if (inQ(cs[0]!.lat, cs[0]!.lon)) return { ...none, point: { lat: cs[0]!.lat, lon: cs[0]!.lon } }
    reason ??= 'outside-qline'
  }
  return reason ? { ...none, reason } : none
}

/**
 * Sentences of the NOTAM text that narrow the drawn area without changing
 * its geometry: "... ONLY WITHIN GERMAN TERRITORY.", "AIRSPACE CAT C/D AND
 * ALL ED-R ARE EXCLUDED.", "CTR EDDV EXCLUDED". We draw the listed polygon /
 * circle as-is (clipping needs outlines we don't ship), so clients show
 * this as a note next to the area. null when there is none.
 */
export function notamAreaQualifier(text: string | null | undefined): string | null {
  if (!text) return null
  const ONLY = /\bONLY\s+(?:WITHIN|IN|OVER|INSIDE)\b/
  const sentences = normalizeNotamText(text).split(/\.(?=\s|$)/).map(x => x.replace(/\s+/g, ' ').trim())
  const out: string[] = []
  for (const x of sentences) {
    if (!x) continue
    const i = x.search(ONLY)
    // "... 550000N0063000E ONLY WITHIN GERMAN TERRITORY": keep from the keyword.
    const y = i >= 0 ? x.slice(i) : /\b(?:EXCLUDED|EXCEPTED)\b/.test(x) ? x : ''
    if (!y || y.length > 200 || /\d{4,6}[NS]\s*\d{5,7}[EW]/.test(y)) continue
    out.push(y.charAt(0) + y.slice(1).toLowerCase())
  }
  // "5 NM RADIUS OF A, EXCLUDING 1 NM RADIUS OF B": only A is drawn; say what is cut out.
  const t = normalizeNotamText(text)
  const { masked, cs } = maskCoords(t, coords(t))
  for (const c of circles(masked, cs).excluded) {
    const at = formatCoordinate(c.lat, c.lon, { style: 'COMPACT', hemi: 'trailing', lngFirst: false, compactSeconds: true })
    out.push(`Excluding ${+c.radiusNm.toFixed(2)} NM radius around ${at}`)
  }
  return out.length > 0 ? out.join('. ') : null
}

/** The part of a NotamItem that describes where it applies. */
export interface NotamAreaInput {
  polygon?: NotamPolygonGeometry | null
  lat: number | null
  lon: number | null
  radiusNm?: number | null
}

function inRingLonLat(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number]
    const [xj, yj] = ring[j] as [number, number]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * True when (lat, lon) lies inside the NOTAM's area: its polygon when it has
 * one, else its circle. NOTAMs with only a position (no radius) have no
 * area -> false. Used by in-flight NOTAM warnings/notifications.
 */
export function pointInNotamArea(lat: number, lon: number, n: NotamAreaInput): boolean {
  if (n.polygon) {
    const polys = n.polygon.type === 'Polygon' ? [n.polygon.coordinates] : n.polygon.coordinates
    return polys.some(p => !!p[0] && inRingLonLat(lat, lon, p[0]) && !p.slice(1).some(h => inRingLonLat(lat, lon, h)))
  }
  if (n.lat === null || n.lon === null || !n.radiusNm || n.radiusNm <= 0) return false
  return distNm(lat, lon, n.lat, n.lon) <= n.radiusNm
}

/** Whether the NOTAM has an area at all (polygon, or circle with a radius). */
export function hasNotamArea(n: NotamAreaInput): boolean {
  return !!n.polygon || (n.lat !== null && n.lon !== null && !!n.radiusNm && n.radiusNm > 0)
}
