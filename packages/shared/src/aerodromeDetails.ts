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
  | 'circuit_leg' | 'reporting_point' | 'taxiway' | 'parking' | 'other'

const KINDS: readonly DetailKind[] = [
  'noise_sensitive', 'avoid_area', 'glider_area', 'parachute_area', 'model_area',
  'circuit_leg', 'reporting_point', 'taxiway', 'parking',
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
  /** Drawn from the circuit direction, not from a published outline. */
  schematic?: boolean
  /** Schematic circuit used by one runway direction only, so its sense can be drawn. */
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
  /** Aircraft category the circuit is for (e.g. "ultralight", "glider"), null = all. */
  aircraft: string | null
}

export interface AreaInfo { kind: DetailKind; name: string | null; remark: string | null; floor: DetailLimit | null; ceiling: DetailLimit | null }

export interface LocalInfo {
  circuits: CircuitInfo[]
  localRules: string[]
  hoursRemarks: string[]
  pprRemarks: string[]
  areas: AreaInfo[]
  reportingPoints: { name: string; remark: string | null }[]
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
  const provenance: Record<string, DetailProvenance> = {}
  const prov = nested(props['provenance'])
  if (prov && typeof prov === 'object') {
    for (const [k, v] of Object.entries(prov as Record<string, unknown>)) {
      const p = parseProvenance(v)
      if (p) provenance[k] = p
    }
  }
  return {
    circuits, areas, reportingPoints, provenance,
    localRules: strings(props['local_rules']),
    hoursRemarks: strings(props['hours_remarks']),
    pprRemarks: strings(props['ppr_remarks']),
  }
}

export function hasLocalInfo(i: LocalInfo): boolean {
  return i.circuits.length + i.localRules.length + i.hoursRemarks.length + i.areas.length + i.reportingPoints.length > 0
}

/** "RWY 12 · left-hand · 1300 ft · ultralight". */
export function formatCircuit(c: CircuitInfo): string {
  return [
    `RWY ${c.runway}`,
    c.direction ? `${c.direction}-hand` : 'direction not stated',
    c.altitude_ft ? `${c.altitude_ft} ft${c.altitude_ref ? ` ${c.altitude_ref}` : ''}` : null,
    c.aircraft,
  ].filter(Boolean).join(' · ')
}

// ── Schematic circuits ──────────────────────────────────────────────────────

interface ThresholdLike { designator?: unknown; lat?: unknown; lon?: unknown }
interface RunwayLike { thresholds?: unknown }

const NM = 1852
/** Distance of the downwind leg from the runway, and how far base/crosswind lie beyond the runway ends. */
export const SCHEMATIC_OFFSET_NM = 0.75
export const SCHEMATIC_EXTEND_NM = 0.6

function metres(lat0: number): [number, number] {
  return [111_320 * Math.cos((lat0 * Math.PI) / 180), 110_540]
}

/**
 * A schematic traffic circuit for one runway direction: a rectangle on the
 * stated side (left-hand = turns to the left when taking off on `runway`),
 * downwind SCHEMATIC_OFFSET_NM from the runway, crosswind and base
 * SCHEMATIC_EXTEND_NM beyond the runway ends, as a closed line in flying order
 * (take-off end -> upwind -> crosswind -> downwind -> base -> final). Only a
 * picture of the side and sense of the circuit: never the published pattern.
 * Null when the runway or its thresholds are unknown.
 */
export function schematicCircuit(runways: readonly RunwayLike[], c: CircuitInfo): LineString | null {
  if (!c.direction) return null
  const want = c.runway.toUpperCase().replace(/^RWY\s*/, '')
  for (const r of runways) {
    const ths = (Array.isArray(r.thresholds) ? r.thresholds : []) as ThresholdLike[]
    const i = ths.findIndex(t => String(t.designator ?? '').toUpperCase() === want)
    if (i < 0 || ths.length < 2) continue
    const from = ths[i]!, to = ths[i === 0 ? 1 : 0]!
    if (typeof from.lat !== 'number' || typeof from.lon !== 'number' || typeof to.lat !== 'number' || typeof to.lon !== 'number') return null
    const lat0 = from.lat, lon0 = from.lon
    const [mx, my] = metres(lat0)
    // Local metres, take-off direction along +u, left of it along +v.
    const ex = (to.lon - lon0) * mx, ny = (to.lat - lat0) * my
    const len = Math.hypot(ex, ny)
    if (len < 50) return null
    const u: [number, number] = [ex / len, ny / len]
    const side = c.direction === 'left' ? 1 : -1
    const v: [number, number] = [-u[1] * side, u[0] * side]
    const ext = SCHEMATIC_EXTEND_NM * NM, off = SCHEMATIC_OFFSET_NM * NM
    const at = (along: number, across: number): [number, number] => [
      lon0 + (u[0] * along + v[0] * across) / mx,
      lat0 + (u[1] * along + v[1] * across) / my,
    ]
    const pts = [at(0, 0), at(len + ext, 0), at(len + ext, off), at(-ext, off), at(-ext, 0), at(0, 0)]
    return { type: 'LineString', coordinates: pts.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]) }
  }
  return null
}

/** Which runway (index) a circuit is for, and its side relative to that runway's first threshold. Two circuits
 *  with the same key draw the same rectangle: "06 right-hand" and "24 left-hand" are one pattern flown in opposite
 *  directions. Null when the runway is unknown. */
function patternKey(runways: readonly RunwayLike[], c: CircuitInfo): string | null {
  if (!c.direction) return null
  const want = c.runway.toUpperCase().replace(/^RWY\s*/, '')
  for (let r = 0; r < runways.length; r++) {
    const ths = (Array.isArray(runways[r]!.thresholds) ? runways[r]!.thresholds : []) as ThresholdLike[]
    const i = ths.findIndex(t => String(t.designator ?? '').toUpperCase() === want)
    if (i < 0 || ths.length < 2) continue
    const leftOfFirst = (c.direction === 'left') === (i === 0)
    return `${r}|${leftOfFirst ? 'L' : 'R'}`
  }
  return null
}

const SIDE = { left: 'LH', right: 'RH' } as const

/**
 * Schematic circuit features for aerodromes that state a circuit direction but
 * have no circuit drawn in the details file. `aerodromes` are the country's
 * aerodrome features; `drawn` the aerodromes that already have circuit legs.
 * Circuits that describe the same rectangle (one runway, one side) become one
 * feature named after all of them ("RWY 06 RH · RWY 24 LH"); `oneWay` is true
 * when only one runway direction uses it, so the direction can be shown.
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
    const groups = new Map<string, { first: CircuitInfo; names: string[] }>()
    for (const c of info.circuits) {
      const key = patternKey(runways, c)
      if (!key) continue
      const name = `RWY ${c.runway} ${SIDE[c.direction!]}`
      const g = groups.get(key)
      if (!g) groups.set(key, { first: c, names: [name] })
      else if (!g.names.includes(name)) g.names.push(name)     // categories share one picture
    }
    for (const g of groups.values()) {
      const geom = schematicCircuit(runways, g.first)
      if (!geom) continue
      out.push({
        type: 'Feature', geometry: geom,
        properties: {
          aerodrome: id, kind: 'circuit_leg', name: g.names.join(' · '),
          remarks: null, floor: null, ceiling: null, approximate: true, accuracy_m: null,
          pending: info.provenance['circuits']?.review === 'pending', schematic: true, oneWay: g.names.length === 1,
          ...(info.provenance['circuits'] ? { provenance: info.provenance['circuits'] } : {}),
        },
      })
    }
  }
  return out
}

/** Map label for an area: name and heights on separate lines. */
export function areaLabel(p: Pick<DetailProps, 'name' | 'floor' | 'ceiling'>): string {
  return [p.name, formatLimits(p.floor, p.ceiling)].filter(Boolean).join('\n')
}

