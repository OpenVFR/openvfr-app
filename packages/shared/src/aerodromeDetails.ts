/**
 * Aerodrome details: optional per-country file `<cc>-aerodrome-details.geojson`
 * with local aerodrome geometry (noise-sensitive and other areas, circuit legs,
 * extra reporting points, taxiways, parking), plus the local-information
 * fields some deployments add to `<cc>-aerodromes.geojson` (circuits per
 * runway, local rules, hours and PPR remarks).
 *
 * EXPERIMENTAL. A deployment without the file simply shows none of this. How
 * the data is produced is up to the operator; every item carries
 * `provenance` ({source_name, source_url, method, ...}). `review: "pending"`
 * in a provenance marks an unreviewed value in a local preview build: shown,
 * but labelled as such.
 */

import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson'

// ── Kinds ───────────────────────────────────────────────────────────────────

export type DetailKind =
  | 'noise_sensitive' | 'avoid_area' | 'glider_area' | 'parachute_area' | 'model_area'
  | 'circuit_leg' | 'reporting_point' | 'holding' | 'taxiway' | 'parking' | 'other'

const KINDS: readonly DetailKind[] = [
  'noise_sensitive', 'avoid_area', 'glider_area', 'parachute_area', 'model_area',
  'circuit_leg', 'reporting_point', 'holding', 'taxiway', 'parking',
]

/** Areas a pilot keeps out of or flies differently near. */
export const AREA_KINDS: ReadonlySet<DetailKind> = new Set(['noise_sensitive', 'avoid_area', 'glider_area', 'parachute_area', 'model_area'])

export const DETAIL_KIND_LABEL: Record<DetailKind, string> = {
  noise_sensitive: 'Noise-sensitive area',
  avoid_area: 'Area to avoid',
  glider_area: 'Glider area',
  parachute_area: 'Parachute area',
  model_area: 'Model flying area',
  circuit_leg: 'Circuit',
  reporting_point: 'Reporting point',
  holding: 'Holding',
  taxiway: 'Taxiway',
  parking: 'Parking',
  other: 'Other',
}

/** One colour per kind (map fill/outline, list badges). */
export const DETAIL_KIND_COLOR: Record<DetailKind, string> = {
  noise_sensitive: '#f59e0b',
  avoid_area: '#ef4444',
  glider_area: '#22c55e',
  parachute_area: '#a855f7',
  model_area: '#14b8a6',
  circuit_leg: '#38bdf8',
  reporting_point: '#a3e635',
  holding: '#0ca678',
  taxiway: '#94a3b8',
  parking: '#94a3b8',
  other: '#cbd5e1',
}

// ── Vertical limits ─────────────────────────────────────────────────────────

/** A floor or ceiling as published: reference + feet ("UNL" has no feet). */
export interface DetailLimit { ref: 'AGL' | 'AMSL' | 'FL' | 'UNL'; ft?: number }

function parseLimit(v: unknown): DetailLimit | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o['ref'] === 'UNL') return { ref: 'UNL' }
  if ((o['ref'] === 'AGL' || o['ref'] === 'AMSL' || o['ref'] === 'FL') && typeof o['ft'] === 'number'
      && Number.isFinite(o['ft']) && o['ft'] >= 0 && o['ft'] <= 66000) {
    return { ref: o['ref'], ft: Math.round(o['ft']) }
  }
  return null
}

export function formatLimit(l: DetailLimit): string {
  if (l.ref === 'UNL') return 'UNL'
  if (l.ref === 'FL') return `FL${String(Math.round((l.ft ?? 0) / 100)).padStart(3, '0')}`
  if (l.ref === 'AGL' && l.ft === 0) return 'GND'
  return `${l.ft} ft ${l.ref}`
}

/** "GND – 2000 ft AMSL", or null when neither is known. */
export function formatLimits(floor: DetailLimit | null | undefined, ceiling: DetailLimit | null | undefined): string | null {
  if (!floor && !ceiling) return null
  return `${floor ? formatLimit(floor) : '?'} – ${ceiling ? formatLimit(ceiling) : '?'}`
}

// ── Provenance ──────────────────────────────────────────────────────────────

export interface DetailProvenance {
  source_name?: string
  source_url?: string | null
  method?: string
  /** "pending": unreviewed value in a local preview build. */
  review?: 'pending'
  /** Every source of a field merged from several (best first), when there is more than one. */
  sources?: { source_name?: string; source_url: string | null; method?: string }[]
}

function parseProvenance(v: unknown): DetailProvenance | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const url = typeof o['source_url'] === 'string' && /^https:\/\//.test(o['source_url']) ? o['source_url'] : null
  return {
    ...(typeof o['source_name'] === 'string' ? { source_name: o['source_name'].slice(0, 120) } : {}),
    source_url: url,
    ...(typeof o['method'] === 'string' ? { method: o['method'] } : {}),
    ...(o['review'] === 'pending' ? { review: 'pending' as const } : {}),
    ...(Array.isArray(o['sources']) && o['sources'].length > 1 ? {
      sources: o['sources'].slice(0, 8).map(parseProvenance).filter((x): x is DetailProvenance => !!x?.source_name)
        .map(x => ({ source_name: x.source_name, source_url: x.source_url ?? null, ...(x.method ? { method: x.method } : {}) })),
    } : {}),
  }
}

// ── The details file ────────────────────────────────────────────────────────

export interface DetailProps {
  /** ICAO code, or the deployment's local id for aerodromes without one. */
  aerodrome: string
  kind: DetailKind
  name: string | null
  remarks: string | null
  floor: DetailLimit | null
  ceiling: DetailLimit | null
  /** "approximate": the outline was read off a chart; `accuracy_m` says how well. */
  approximate: boolean
  accuracy_m: number | null
  /** Unreviewed (local preview). */
  pending: boolean
  /** Drawn from the circuit direction, not from a published outline (a turn arrow, see circuitTurnArrow). */
  schematic?: boolean
  /** Holding: the orbit flown there (left = counter-clockwise). */
  direction?: 'left' | 'right'
  /** Parts of a turn arrow: the curved line with its head ('turn'), or the point its label sits on ('label'). */
  role?: 'turn' | 'label'
  /** Runway ends the circuit is for, as "|06|24|", so the map can show only the circuits of a chosen runway. */
  rwys?: string
  /** false: a drawn pattern flown both ways (06 right-hand = 24 left-hand), so no direction chevrons. */
  oneWay?: boolean
  provenance?: DetailProvenance
}

export type DetailFeature = Feature<Geometry, DetailProps>

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null

function okPosition(p: unknown): boolean {
  return Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number'
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90
}

function okGeometry(g: unknown): g is Geometry {
  if (!g || typeof g !== 'object') return false
  const o = g as { type?: string; coordinates?: unknown }
  const c = o.coordinates
  if (o.type === 'Point') return okPosition(c)
  if (o.type === 'LineString') return Array.isArray(c) && c.length >= 2 && c.length <= 5000 && c.every(okPosition)
  if (o.type === 'Polygon') {
    return Array.isArray(c) && c.length >= 1 && c.length <= 50
      && c.every(r => Array.isArray(r) && r.length >= 4 && r.length <= 5000 && r.every(okPosition))
  }
  return false
}

/** Validate an untrusted details file; malformed features are dropped. */
export function parseAerodromeDetails(raw: unknown): FeatureCollection<Geometry, DetailProps> | null {
  if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'FeatureCollection') return null
  const feats = (raw as { features?: unknown }).features
  if (!Array.isArray(feats)) return null
  const out: DetailFeature[] = []
  for (const f of feats.slice(0, 20000)) {
    if (!f || typeof f !== 'object' || !okGeometry((f as Feature).geometry)) continue
    const p = ((f as Feature).properties ?? {}) as Record<string, unknown>
    const aerodrome = text(p['icao'], 12) ?? text(p['local_id'], 40)
    if (!aerodrome) continue
    const kind = KINDS.includes(p['kind'] as DetailKind) ? p['kind'] as DetailKind : 'other'
    const provenance = parseProvenance(p['provenance'])
    out.push({
      type: 'Feature',
      geometry: (f as Feature).geometry,
      properties: {
        aerodrome, kind,
        name: text(p['name'], 80),
        remarks: text(p['remarks'], 300),
        floor: parseLimit(p['floor']),
        ceiling: parseLimit(p['ceiling']),
        approximate: p['geometry_quality'] === 'approximate',
        accuracy_m: typeof p['accuracy_m'] === 'number' ? Math.round(p['accuracy_m']) : null,
        pending: provenance?.review === 'pending',
        ...(kind === 'holding' && (p['direction'] === 'left' || p['direction'] === 'right') ? { direction: p['direction'] } : {}),
        // circuits read off a club chart: which runway ends use them (runway focus), and whether one sense only
        ...(typeof p['rwys'] === 'string' && /^\|([0-9]{2}[LRC]?\|)+$/.test(p['rwys']) ? { rwys: p['rwys'] } : {}),
        ...(typeof p['oneWay'] === 'boolean' ? { oneWay: p['oneWay'] } : {}),
        ...(provenance ? { provenance } : {}),
      },
    })
  }
  return { type: 'FeatureCollection', features: out }
}

// ── Local-information fields on the aerodrome itself ───────────────────────

export interface CircuitInfo {
  runway: string
  direction: 'left' | 'right' | null
  altitude_ft: number | null
  altitude_ref: string | null
  /** Aircraft category the circuit is for (e.g. "ultralight", "glider", "heavy" = above a mass limit such as
   *  MTOM 5700 kg), null = all. */
  aircraft: string | null
}

export interface HoldingInfo { name: string; direction: 'left' | 'right' | null; description: string | null }

export interface AreaInfo { kind: DetailKind; name: string | null; remark: string | null; floor: DetailLimit | null; ceiling: DetailLimit | null }

export interface LocalInfo {
  circuits: CircuitInfo[]
  localRules: string[]
  hoursRemarks: string[]
  pprRemarks: string[]
  areas: AreaInfo[]
  reportingPoints: { name: string; remark: string | null }[]
  /** VFR holding points ("WEST") with the orbit flown there and where to hold. */
  holdings: HoldingInfo[]
  /** Per field: where it came from (and whether it is unreviewed). */
  provenance: Record<string, DetailProvenance>
}

/** MapLibre serialises nested properties as JSON strings; accept both. */
function nested(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

const list = (v: unknown): unknown[] => { const n = nested(v); return Array.isArray(n) ? n : [] }
const strings = (v: unknown, max = 400): string[] => {
  const n = nested(v)
  return (Array.isArray(n) ? n : typeof n === 'string' ? [n] : []).map(s => text(s, max)).filter((s): s is string => !!s)
}

/** The local-information fields of an aerodrome's properties (absent fields are empty). */
export function localInfo(props: Record<string, unknown>): LocalInfo {
  const circuits: CircuitInfo[] = []
  for (const c of list(props['circuits'])) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const runway = text(o['runway'], 8)
    if (!runway) continue
    circuits.push({
      runway,
      direction: o['direction'] === 'left' || o['direction'] === 'right' ? o['direction'] : null,
      altitude_ft: typeof o['altitude_ft'] === 'number' && o['altitude_ft'] > 0 && o['altitude_ft'] < 20000 ? Math.round(o['altitude_ft']) : null,
      altitude_ref: text(o['altitude_ref'], 8),
      aircraft: text(o['aircraft'], 30),
    })
  }
  const areas: AreaInfo[] = []
  for (const a of list(props['areas'])) {
    if (!a || typeof a !== 'object') continue
    const o = a as Record<string, unknown>
    const kind = KINDS.includes(o['kind'] as DetailKind) ? o['kind'] as DetailKind : 'other'
    areas.push({ kind, name: text(o['name'], 80), remark: text(o['remark'], 200), floor: parseLimit(o['floor']), ceiling: parseLimit(o['ceiling']) })
  }
  const reportingPoints = list(props['reporting_points'])
    .map(p => (p && typeof p === 'object' ? { name: text((p as Record<string, unknown>)['name'], 40), remark: text((p as Record<string, unknown>)['remark'], 200) } : null))
    .filter((p): p is { name: string; remark: string | null } => !!p?.name)
  const holdings: HoldingInfo[] = []
  for (const h of list(props['holdings'])) {
    if (!h || typeof h !== 'object') continue
    const o = h as Record<string, unknown>
    const name = text(o['name'], 40)
    if (!name) continue
    holdings.push({ name, direction: o['direction'] === 'left' || o['direction'] === 'right' ? o['direction'] : null,
      description: text(o['description'], 200) })
  }
  const provenance: Record<string, DetailProvenance> = {}
  const prov = nested(props['provenance'])
  if (prov && typeof prov === 'object') {
    for (const [k, v] of Object.entries(prov as Record<string, unknown>)) {
      const p = parseProvenance(v)
      if (p) provenance[k] = p
    }
  }
  return {
    circuits, areas, reportingPoints, holdings, provenance,
    localRules: strings(props['local_rules']),
    hoursRemarks: strings(props['hours_remarks']),
    pprRemarks: strings(props['ppr_remarks']),
  }
}

export function hasLocalInfo(i: LocalInfo): boolean {
  return i.circuits.length + i.localRules.length + i.hoursRemarks.length + i.areas.length + i.reportingPoints.length + i.holdings.length > 0
}

const AIRCRAFT_LABEL: Record<string, string> = { heavy: 'aircraft over 5700 kg MTOM' }

/** Circuits only for heavy aircraft are listed, not drawn: a light-aircraft pilot would read them as theirs. */
export const isDrawnCircuit = (c: CircuitInfo): boolean => c.aircraft !== 'heavy'

/** "RWY 12 · left-hand · 1300 ft · ultralight". */
export function formatCircuit(c: CircuitInfo): string {
  return [
    `RWY ${c.runway}`,
    c.direction ? `${c.direction}-hand` : 'direction not stated',
    c.altitude_ft ? `${c.altitude_ft} ft${c.altitude_ref ? ` ${c.altitude_ref}` : ''}` : null,
    c.aircraft ? (AIRCRAFT_LABEL[c.aircraft] ?? c.aircraft) : null,
  ].filter(Boolean).join(' · ')
}

// ── Schematic circuits ──────────────────────────────────────────────────────

interface ThresholdLike { designator?: unknown; lat?: unknown; lon?: unknown }
interface RunwayLike { thresholds?: unknown; designator?: unknown; surface?: unknown }

const GRASS = /\b(grass|gräs|turf|unpaved)\b/i
const ths = (r: RunwayLike): ThresholdLike[] => (Array.isArray(r.thresholds) ? r.thresholds : []) as ThresholdLike[]

/**
 * The runway and threshold index a circuit is for, and that threshold's designator. Exact designator first,
 * otherwise without the L/R/C suffix ("12R" in the AIP where the runway data only says "12"). When several runways
 * carry it (an asphalt runway and a grass strip, both 12/30) gliders get the grass strip, everyone else the paved one.
 */
function findThreshold(runways: readonly RunwayLike[], c: CircuitInfo): { r: number; i: number; designator: string } | null {
  const want = c.runway.toUpperCase().replace(/^RWY\s*/, '').trim()
  const hits = (eq: (d: string) => boolean) => runways.flatMap((rw, r) => {
    const t = ths(rw)
    const i = t.findIndex(x => eq(String(x.designator ?? '').toUpperCase()))
    return i >= 0 && t.length >= 2 ? [{ r, i, designator: String(t[i]!.designator).toUpperCase() }] : []
  })
  const bare = (d: string) => d.replace(/[LRC]$/, '')
  const exact = hits(d => d === want)
  const found = exact.length ? exact : hits(d => bare(d) === bare(want))
  if (!found.length) return null
  const grassy = (h: { r: number }) => GRASS.test(`${runways[h.r]!.designator ?? ''} ${runways[h.r]!.surface ?? ''}`)
  return (c.aircraft === 'glider' ? found.find(grassy) : found.find(h => !grassy(h))) ?? found[0]!
}

const NM = 1852
/** Turn arrow: straight on past the departure end, then a quarter turn toward the circuit side. */
export const TURN_STRAIGHT_NM = 0.25
export const TURN_RADIUS_NM = 0.3
const HEAD_NM = 0.09

function metres(lat0: number): [number, number] {
  return [111_320 * Math.cos((lat0 * Math.PI) / 180), 110_540]
}

export interface TurnArrow {
  /** Curved line from the departure end of the runway, in flying order. */
  arc: LineString
  /** Arrowhead at the end of the arc (barb, tip, barb). */
  head: LineString
  /** Where the label goes: just beyond the tip, on the circuit side. */
  label: [number, number]
  /** The runway data's designator of the take-off end ("12" for an AIP's "12R"). */
  designator: string
}

/**
 * A circuit known only by runway and direction, drawn as what it says: after take-off on `runway`, turn left/right.
 * The arrow starts at the far (departure) end of the runway, runs TURN_STRAIGHT_NM straight on and turns through
 * 90 degrees toward the circuit side. It never suggests a pattern size or shape. Null when the runway or its
 * thresholds are unknown or the direction is not stated.
 */
export function circuitTurnArrow(runways: readonly RunwayLike[], c: CircuitInfo): TurnArrow | null {
  if (!c.direction) return null
  const hit = findThreshold(runways, c)
  if (!hit) return null
  const t = ths(runways[hit.r]!)
  const from = t[hit.i]!, to = t[hit.i === 0 ? 1 : 0]!
  if (typeof from.lat !== 'number' || typeof from.lon !== 'number' || typeof to.lat !== 'number' || typeof to.lon !== 'number') return null
  const lat0 = to.lat, lon0 = to.lon
  const [mx, my] = metres(lat0)
  const ex = (to.lon - from.lon) * mx, ny = (to.lat - from.lat) * my
  const len = Math.hypot(ex, ny)
  if (len < 50) return null
  const u: [number, number] = [ex / len, ny / len]                    // take-off direction
  const side = c.direction === 'left' ? 1 : -1
  const v: [number, number] = [-u[1] * side, u[0] * side]            // toward the circuit side
  const at = (along: number, across: number): [number, number] => [
    Math.round((lon0 + (u[0] * along + v[0] * across) / mx) * 1e6) / 1e6,
    Math.round((lat0 + (u[1] * along + v[1] * across) / my) * 1e6) / 1e6,
  ]
  const s = TURN_STRAIGHT_NM * NM, r = TURN_RADIUS_NM * NM, h = HEAD_NM * NM
  const arc: [number, number][] = [at(0, 0), at(s, 0)]
  for (let k = 1; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2)
    arc.push(at(s + r * Math.sin(a), r * (1 - Math.cos(a))))
  }
  // tip points along +v; barbs go back toward -v, spread along ±u
  const tipAlong = s + r, tipAcross = r
  const head = [at(tipAlong - h * 0.6, tipAcross - h), at(tipAlong, tipAcross), at(tipAlong + h * 0.6, tipAcross - h)]
  return { arc: { type: 'LineString', coordinates: arc }, head: { type: 'LineString', coordinates: head },
    label: at(tipAlong, tipAcross + h * 1.4), designator: hit.designator }
}

/** "left-hand orbit (counter-clockwise)". */
export const orbitLabel = (d: 'left' | 'right'): string =>
  d === 'left' ? 'left-hand orbit (counter-clockwise)' : 'right-hand orbit (clockwise)'

/** Orbit drawn around a holding symbol: radius and the gap left open so the arrowhead reads. */
export const ORBIT_RADIUS_NM = 0.3
const ORBIT_SWEEP = (300 * Math.PI) / 180

/**
 * The orbit flown at a holding point, as a line around it with an arrowhead: left = counter-clockwise (turning
 * left), right = clockwise. 300 degrees of a circle, starting south-east of the point. [arc, head].
 */
export function holdingOrbit(center: [number, number], direction: 'left' | 'right'): [LineString, LineString] {
  const [lon0, lat0] = center
  const [mx, my] = metres(lat0)
  const r = ORBIT_RADIUS_NM * NM, h = HEAD_NM * NM
  const sense = direction === 'left' ? 1 : -1
  const start = direction === 'left' ? -Math.PI / 3 : (-2 * Math.PI) / 3
  const pt = (x: number, y: number): [number, number] =>
    [Math.round((lon0 + x / mx) * 1e6) / 1e6, Math.round((lat0 + y / my) * 1e6) / 1e6]
  const arc: [number, number][] = []
  for (let k = 0; k <= 24; k++) {
    const a = start + sense * ORBIT_SWEEP * (k / 24)
    arc.push(pt(r * Math.cos(a), r * Math.sin(a)))
  }
  const end = start + sense * ORBIT_SWEEP
  const [tx, ty] = [-Math.sin(end) * sense, Math.cos(end) * sense]   // flying direction at the tip
  const [nx, ny] = [Math.cos(end), Math.sin(end)]                     // outward
  const tip: [number, number] = [r * Math.cos(end), r * Math.sin(end)]
  const barb = (side: number) => pt(tip[0] - h * tx + side * 0.6 * h * nx, tip[1] - h * ty + side * 0.6 * h * ny)
  return [{ type: 'LineString', coordinates: arc },
    { type: 'LineString', coordinates: [barb(1), pt(tip[0], tip[1]), barb(-1)] }]
}

/** Orbit features for the holding points in a details file that state a direction (role 'turn'). */
export function holdingOrbitFeatures(details: readonly DetailFeature[]): DetailFeature[] {
  const out: DetailFeature[] = []
  for (const f of details) {
    const d = f.properties.direction
    if (f.properties.kind !== 'holding' || !d || f.geometry.type !== 'Point') continue
    const c = f.geometry.coordinates as [number, number]
    for (const g of holdingOrbit([c[0], c[1]], d)) out.push({ type: 'Feature', geometry: g, properties: { ...f.properties, role: 'turn' } })
  }
  return out
}

const SIDE = { left: 'LH', right: 'RH' } as const
const GROUP_LABEL: Record<string, string> = { glider: 'gliders', ultralight: 'ultralights', gyro: 'gyros', helicopter: 'helicopters' }

/**
 * Turn arrows for aerodromes that state a circuit direction but have no circuit drawn in the details file.
 * `aerodromes` are the country's aerodrome features; `drawn` the aerodromes that already have circuit legs.
 * One arrow per runway end and direction ("RWY 06 RH"); aircraft categories that share it are merged, and the
 * label names them only when no circuit for all/powered aircraft is among them ("RWY 30 RH · gliders").
 * Each arrow is three features: arc and head (role 'turn') and a label point (role 'label').
 */
export function schematicCircuitFeatures(
  aerodromes: readonly Feature[],
  drawn: ReadonlySet<string>,
): DetailFeature[] {
  const out: DetailFeature[] = []
  for (const a of aerodromes) {
    const p = (a.properties ?? {}) as Record<string, unknown>
    const id = text(p['icao'], 12) ?? text(p['local_id'], 40)
    if (!id || drawn.has(id)) continue
    const info = localInfo(p)
    if (!info.circuits.length) continue
    const runways = list(p['runways']) as RunwayLike[]
    const groups = new Map<string, { arrow: TurnArrow; direction: 'left' | 'right'; groups: Set<string>; forAll: boolean }>()
    for (const c of info.circuits.filter(isDrawnCircuit)) {
      const arrow = circuitTurnArrow(runways, c)
      if (!arrow) continue
      const hit = findThreshold(runways, c)!
      const key = `${hit.r}|${hit.i}|${c.direction}`
      const g = groups.get(key) ?? { arrow, direction: c.direction!, groups: new Set<string>(), forAll: false }
      const label = c.aircraft ? GROUP_LABEL[c.aircraft] : undefined
      if (label) g.groups.add(label); else g.forAll = true
      groups.set(key, g)
    }
    const pending = info.provenance['circuits']?.review === 'pending'
    const provenance = info.provenance['circuits'] ? { provenance: info.provenance['circuits'] } : {}
    for (const g of groups.values()) {
      const name = [`RWY ${g.arrow.designator} ${SIDE[g.direction]}`, g.forAll ? null : [...g.groups].join(', ')]
        .filter(Boolean).join(' · ')
      const base = { aerodrome: id, kind: 'circuit_leg' as const, name, remarks: null, floor: null, ceiling: null,
        approximate: true, accuracy_m: null, pending, schematic: true, rwys: `|${g.arrow.designator}|`, ...provenance }
      out.push({ type: 'Feature', geometry: g.arrow.arc, properties: { ...base, role: 'turn' } })
      out.push({ type: 'Feature', geometry: g.arrow.head, properties: { ...base, role: 'turn' } })
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: g.arrow.label }, properties: { ...base, role: 'label' } })
    }
  }
  return out
}

/** Map label for an area: name and heights on separate lines. */
export function areaLabel(p: Pick<DetailProps, 'name' | 'floor' | 'ceiling'>): string {
  return [p.name, formatLimits(p.floor, p.ceiling)].filter(Boolean).join('\n')
}

