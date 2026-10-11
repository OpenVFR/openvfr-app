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
 *   1. polygons: runs of >= 3 coordinates joined by "-" (closed if needed);
 *      several runs -> MultiPolygon (several areas in one NOTAM);
 *   2. a single circle: "<r> NM RADIUS OF/CENTRED ON <coord>",
 *      "RADIUS <r> NM CENTRED ON <coord>", "<coord> RADIUS <r> NM", ...;
 *   3. a precise point: "PSN <coord>" (obstacles; the Q-line centre is
 *      rounded to whole minutes, ~1 NM).
 * Not handled (Q-line circle stays): arcs, "along the border", lines
 * between two points, areas named only by designator.
 *
 * Every result is sanity-checked against the Q-line circle so a stray
 * coordinate in the text (a reference point, a phone-number-like token)
 * can never move a NOTAM somewhere unrelated.
 */
import type { NotamPolygonGeometry } from './notamCoverageArea'

export interface TextCircle { lat: number; lon: number; radiusNm: number }
export interface TextPoint  { lat: number; lon: number }

export interface NotamTextGeometry {
  polygon: NotamPolygonGeometry | null
  circle: TextCircle | null
  point: TextPoint | null
}

// DDMM[SS[.s]]N DDDMM[SS[.s]]E, optional whitespace between lat and lon.
const COORD_SRC = String.raw`(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?([EW])`
const COORD = new RegExp(COORD_SRC, 'g')
const UNIT = String.raw`(\d+(?:\.\d+)?)\s?(NM|KM|M)\b`

interface Coord { lat: number; lon: number; start: number; end: number }

function toDeg(d: string, m: string, s: string | undefined, hemi: string): number {
  const v = Number(d) + Number(m) / 60 + (s ? Number(s) / 3600 : 0)
  return hemi === 'S' || hemi === 'W' ? -v : v
}

function plausible(lat: number, lon: number): boolean {
  return lat >= 25 && lat <= 75 && lon >= -35 && lon <= 50
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

function coords(t: string): Coord[] {
  const out: Coord[] = []
  for (const m of t.matchAll(COORD)) {
    const [, la1, la2, la3, ns, lo1, lo2, lo3, ew] = m
    const lat = toDeg(la1!, la2!, la3, ns!)
    const lon = toDeg(lo1!, lo2!, lo3, ew!)
    if (Number(la2) >= 60 || Number(lo2) >= 60 || !plausible(lat, lon)) continue
    out.push({ lat, lon, start: m.index!, end: m.index! + m[0].length })
  }
  return out
}

// Boundary segment along an arc, between two vertices:
//   A ALONG A (COUNTER/ANTI-)CLOCKWISE ARC (RADIUS 8NM WITH CENTRE <c>) TO B
const ARC = new RegExp(String.raw`ALONG\s+(?:AN?\s+|THE\s+)?(CLOCKWISE|COUNTER[- ]?CLOCKWISE|ANTI[- ]?CLOCKWISE)\s+ARC\s*\(?\s*(?:WITH\s+)?(?:A\s+)?RADIUS\s+(?:OF\s+)?${UNIT}\s*,?\s*(?:WITH\s+)?(?:CENTRE|CENTER|CENTRED ON|CENTERED ON)\s*(?:AT|ON)?\s*${COORD_SRC}\s*\)?\s*TO`, 'g')

interface ArcClause { start: number; end: number; clockwise: boolean; lat: number; lon: number }

function arcClauses(t: string): ArcClause[] {
  const out: ArcClause[] = []
  for (const m of t.matchAll(ARC)) {
    const [, dir, , , la1, la2, la3, ns, lo1, lo2, lo3, ew] = m
    out.push({
      start: m.index!, end: m.index! + m[0].length,
      clockwise: dir === 'CLOCKWISE',
      lat: toDeg(la1!, la2!, la3, ns!), lon: toDeg(lo1!, lo2!, lo3, ew!),
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

function polygons(t: string, all: Coord[]): number[][][] {
  const arcs = arcClauses(t)
  // An arc's centre is not a boundary vertex.
  const cs = all.filter(c => !arcs.some(a => c.start >= a.start && c.end <= a.end))
  const rings: number[][][] = []
  let ring: number[][] = []
  let vertices = 0
  let first: Coord | null = null
  let prev: Coord | null = null
  const flush = () => {
    if (vertices >= 3 && ring.length >= 3) {
      const [f, l] = [ring[0]!, ring[ring.length - 1]!]
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0]!, f[1]!])
      rings.push(ring)
    }
    ring = []; vertices = 0; first = null; prev = null
  }
  for (const c of cs) {
    if (prev) {
      const gap = t.slice(prev.end, c.start)
      const arc = arcs.find(a => a.start >= prev!.end && a.end <= c.start)
      if (arc && /^\s*$/.test(t.slice(prev.end, arc.start)) && /^\s*$/.test(t.slice(arc.end, c.start))) {
        ring.push(...arcPoints(prev, c, arc))
      } else if (/^\s*BACK\s+TO\s*$/.test(gap) && first) {
        ring.push([c.lon, c.lat]); prev = c
        flush(); continue // closed explicitly
      } else if (!/^\s*[-\u2013,]?\s*$/.test(gap)) {
        flush()
      }
    }
    if (!first) first = c
    ring.push([c.lon, c.lat]); vertices++
    prev = c
  }
  flush()
  return rings
}

function toNm(value: string, unit: string): number {
  const v = Number(value)
  return unit === 'NM' ? v : unit === 'KM' ? v / 1.852 : v / 1852
}

const CIRCLE_PATTERNS: RegExp[] = [
  // 0.5NM RADIUS OF <c> / 1NM RADIUS CENTERED ON <c> / 2 KM RADIUS AROUND PSN <c>
  new RegExp(String.raw`${UNIT}\s+RADIUS\s+(?:OF|AROUND|CENTRED ON|CENTERED ON|CENTRED AT|CENTERED AT|CENTRE|CENTER)?\s*(?:PSN|POSITION)?\s*:?\s*${COORD_SRC}`, 'g'),
  // RADIUS (OF) 1.5NM CENTERED ON <c> / CIRCLE RADIUS 2NM CENTRE <c>
  new RegExp(String.raw`RADIUS\s+(?:OF\s+)?${UNIT}\s*,?\s*(?:WITH\s+)?(?:CENTRED|CENTERED|CENTRE|CENTER|AROUND)\s*(?:ON|AT)?\s*(?:PSN|POSITION)?\s*:?\s*${COORD_SRC}`, 'g'),
]
// <c> RADIUS 2NM / PSN <c> WITH A RADIUS OF 500M (coordinate first)
const CIRCLE_COORD_FIRST = new RegExp(String.raw`${COORD_SRC}\s*(?:\([^)]{0,80}\))?\s*,?\s*(?:WITH\s+)?(?:A\s+)?RADIUS\s+(?:OF\s+)?${UNIT}`, 'g')

function circles(t: string): TextCircle[] {
  const out: TextCircle[] = []
  for (const re of CIRCLE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const [, v, u, la1, la2, la3, ns, lo1, lo2, lo3, ew] = m
      out.push({ lat: toDeg(la1!, la2!, la3, ns!), lon: toDeg(lo1!, lo2!, lo3, ew!), radiusNm: toNm(v!, u!) })
    }
  }
  for (const m of t.matchAll(CIRCLE_COORD_FIRST)) {
    const [, la1, la2, la3, ns, lo1, lo2, lo3, ew, v, u] = m
    out.push({ lat: toDeg(la1!, la2!, la3, ns!), lon: toDeg(lo1!, lo2!, lo3, ew!), radiusNm: toNm(v!, u!) })
  }
  const uniq = new Map(out.filter(c => plausible(c.lat, c.lon) && c.radiusNm > 0 && c.radiusNm <= 200)
    .map(c => [`${c.lat.toFixed(4)},${c.lon.toFixed(4)},${c.radiusNm.toFixed(3)}`, c]))
  return [...uniq.values()]
}

const PSN = new RegExp(String.raw`\b(?:PSN|POSITION)\s*:?\s*${COORD_SRC}`, 'g')

function points(t: string): TextPoint[] {
  const uniq = new Map<string, TextPoint>()
  for (const m of t.matchAll(PSN)) {
    const [, la1, la2, la3, ns, lo1, lo2, lo3, ew] = m
    const p = { lat: toDeg(la1!, la2!, la3, ns!), lon: toDeg(lo1!, lo2!, lo3, ew!) }
    if (plausible(p.lat, p.lon)) uniq.set(`${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, p)
  }
  return [...uniq.values()]
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
  const tol = (r: number) => r * 1.25 + 5
  const inQ = (lat: number, lon: number) =>
    !checkQ || distNm(lat, lon, q.lat, q.lon) <= tol(q.radiusNm!)

  const cs = coords(t)
  const rings = polygons(t, cs).filter(r => r.every(([lon, lat]) => inQ(lat!, lon!)))
  if (rings.length === 1) return { ...none, polygon: { type: 'Polygon', coordinates: [rings[0]!] } }
  if (rings.length > 1) return { ...none, polygon: { type: 'MultiPolygon', coordinates: rings.map(r => [r]) } }

  const cc = circles(t).filter(c => inQ(c.lat, c.lon))
  if (cc.length === 1) return { ...none, circle: cc[0]! }
  if (cc.length > 1) return none // several circles: the Q envelope is the honest summary

  const ps = points(t).filter(p => inQ(p.lat, p.lon))
  if (ps.length === 1) return { ...none, point: ps[0]! }
  return none
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
