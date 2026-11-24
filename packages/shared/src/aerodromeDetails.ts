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
import { CIRCUIT_GROUP_COLOR, DETAIL_KIND_COLOR } from './featureColors'
export { CIRCUIT_GROUP_COLOR, DETAIL_KIND_COLOR }   // the palettes live in featureColors (the one source of aviation colours)


// ── Kinds ───────────────────────────────────────────────────────────────────

export type DetailKind =
  | 'noise_sensitive' | 'avoid_area' | 'glider_area' | 'parachute_area' | 'model_area'
  | 'circuit_leg' | 'arrival_route' | 'reporting_point' | 'holding' | 'taxiway' | 'parking' | 'other'

const KINDS: readonly DetailKind[] = [
  'noise_sensitive', 'avoid_area', 'glider_area', 'parachute_area', 'model_area',
  'circuit_leg', 'arrival_route', 'reporting_point', 'holding', 'taxiway', 'parking',
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
  arrival_route: 'Arrival route',
  reporting_point: 'Reporting point',
  holding: 'Holding',
  taxiway: 'Taxiway',
  parking: 'Parking',
  other: 'Other',
}

/** Aircraft groups that get their own circuit colour (a club map draws them in different colours too). */
export type CircuitGroup = 'powered' | 'glider' | 'ultralight' | 'helicopter' | 'gyro'
export const CIRCUIT_GROUPS: readonly CircuitGroup[] = ['powered', 'glider', 'ultralight', 'helicopter', 'gyro']


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
  /** A reporting point placed on the landmark of the same name: its label is left off (the landmark's names it). */
  on_landmark?: boolean
  /** Circuit for one aircraft group only (glider, ultralight, helicopter, gyro; powered = the default colour). */
  aircraft?: string
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
        // a reporting point sitting on a landmark (same name): the landmark's own label names it
        ...(p['on_landmark'] === true ? { on_landmark: true } : {}),
        ...(kind === 'circuit_leg' && typeof p['aircraft'] === 'string' && CIRCUIT_GROUPS.includes(p['aircraft'] as CircuitGroup)
          ? { aircraft: p['aircraft'] } : {}),
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

/** A list this long is shown grouped and folded; a shorter one is shown whole as a plain list. */
export const RULES_GROUPED_MIN = 7
/** Stable ids of the local-rule headings, in display order. Logic (grouping, sorting, fold state) uses the id; the English text is a label only. */
export const RULE_GROUP_IDS = ['aip', 'arrival_circuit', 'obstacles', 'noise_neighbours', 'animals', 'procedures', 'other'] as const
export type RuleGroupId = (typeof RULE_GROUP_IDS)[number]
export const RULE_GROUP_LABEL: Record<RuleGroupId, string> = {
  aip: 'AIP', arrival_circuit: 'Arrival and circuit', obstacles: 'Obstacles', noise_neighbours: 'Noise and neighbours',
  animals: 'Animals', procedures: 'Procedures', other: 'Other',
}
/** The headings the curated data carries as text, to their ids. A heading not listed here is kept as its own group under its own text, after the known ones. */
const RULE_GROUP_OF_TITLE: Record<string, RuleGroupId> = Object.fromEntries(
  RULE_GROUP_IDS.map(id => [RULE_GROUP_LABEL[id], id]),
) as Record<string, RuleGroupId>

/** Local rules under a heading (the curated `local_rule_groups`: rows of `title`, `text`, `key`): `key` lines are shown up front, the
 *  others fold away under the heading. */
export interface RuleGroup {
  /** A `RuleGroupId`, or the heading's own text for a heading this version does not know. */
  id: string
  title: string
  lines: { text: string; key: boolean }[]
}

export interface LocalInfo {
  circuits: CircuitInfo[]
  /** The runway ends the aerodrome has ("12", "30", "04L"): what a circuit note can say is not stated. */
  runwayEnds: string[]
  localRules: string[]
  /** The same rules grouped, or null (no tidy version: show `localRules` as a plain list). */
  localRuleGroups: RuleGroup[] | null
  hoursRemarks: string[]
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

/** The grouped rules (`local_rule_groups`), headings in a fixed order; null when absent or too short to need grouping. */
function ruleGroups(v: unknown): RuleGroup[] | null {
  const n = nested(v)
  if (!Array.isArray(n)) return null
  const by = new Map<string, RuleGroup>()
  let count = 0
  for (const r of n) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const t = text(o['text'], 400)
    if (!t) continue
    const title = text(o['title'], 40) ?? RULE_GROUP_LABEL.other
    const id = RULE_GROUP_OF_TITLE[title] ?? title
    if (!by.has(id)) by.set(id, { id, title, lines: [] })
    by.get(id)!.lines.push({ text: t, key: o['key'] === true })
    count++
  }
  if (count < RULES_GROUPED_MIN) return null
  const rank = (id: string) => { const i = (RULE_GROUP_IDS as readonly string[]).indexOf(id); return i < 0 ? RULE_GROUP_IDS.length : i }      // an unknown heading after every known one
  return [...by.values()].sort((a, b) => rank(a.id) - rank(b.id))
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
    circuits, areas, reportingPoints, holdings, provenance, runwayEnds: runwayEndsOf(list(props['runways']) as RunwayLike[]),
    localRules: strings(props['local_rules']),
    localRuleGroups: ruleGroups(props['local_rule_groups']),
    hoursRemarks: strings(props['hours_remarks']),
  }
}

export function hasLocalInfo(i: LocalInfo): boolean {
  return i.circuits.length + i.localRules.length + i.hoursRemarks.length + i.areas.length + i.reportingPoints.length + i.holdings.length > 0
}

const AIRCRAFT_LABEL: Record<string, string> = { heavy: 'aircraft over 5700 kg MTOM' }

/** Circuits only for heavy aircraft are listed, not drawn: a light-aircraft pilot would read them as theirs. */
export const isDrawnCircuit = (c: CircuitInfo): boolean => c.aircraft !== 'heavy'

const SUFFIX_FLIP: Record<string, string> = { L: 'R', R: 'L', C: 'C', '': '' }

/** The two ends a runway designator names: "12/30" -> 12, 30; "18" -> 18, 36; "04L" -> 04L, 22R. Nothing for a designator that is not one. */
export function endsOfDesignator(d: unknown): string[] {
  const s = String(d ?? '').trim().toUpperCase()
  const pair = /^(\d{2})([LRC]?)\s*\/\s*(\d{2})([LRC]?)$/.exec(s)
  if (pair) return [pair[1]! + pair[2]!, pair[3]! + pair[4]!]
  const one = /^(\d{2})([LRC]?)$/.exec(s)
  if (!one) return []
  const n = Number(one[1])
  const other = ((n + 17) % 36) + 1
  return [one[1]! + one[2]!, String(other).padStart(2, '0') + SUFFIX_FLIP[one[2]!]!]
}

/** Every runway end of an aerodrome's runway list, in order, once each. */
export function runwayEndsOf(runways: readonly RunwayLike[]): string[] {
  const out: string[] = []
  for (const r of runways) {
    const fromThresholds = ths(r).map(t => String(t.designator ?? '').trim().toUpperCase()).filter(d => /^\d{2}[LRC]?$/.test(d))
    for (const e of fromThresholds.length === 2 ? fromThresholds : endsOfDesignator(r.designator)) if (!out.includes(e)) out.push(e)
  }
  return out
}

/**
 * What the circuit note says is NOT stated: the runway ends with no published circuit (for light aircraft: a circuit only for heavy aircraft does not count), when at least one circuit is published at
 * the aerodrome. Without any published circuit there is no note (the block is not shown). A direction nobody published is never drawn: the standard is only named.
 */
export function unstatedCircuitEnds(i: Pick<LocalInfo, 'circuits' | 'runwayEnds'>): string[] {
  const stated = new Set(i.circuits.filter(isDrawnCircuit).map(c => c.runway.toUpperCase().replace(/^RWY\s*/, '').replace(/[LRC]$/, '').trim()))
  if (!stated.size) return []
  return i.runwayEnds.filter(e => !stated.has(e.replace(/[LRC]$/, '')))
}

/** The line under the circuit list for runways without a published circuit. */
export function unstatedCircuitNote(ends: readonly string[]): string {
  return `Not stated for RWY ${ends.join(', ')}. The ICAO standard is left-hand unless published otherwise.`
}

export interface CircuitEntry { direction: 'left' | 'right' | null; text: string }
export interface CircuitEndGroup { runway: string; entries: CircuitEntry[] }

/** A height with its reference; a source that gives none is said so ("1000 ft (reference not stated)"): a bare height is ambiguous (above the field or above sea level) and no reference is guessed. */
const heightOf = (c: CircuitInfo): string | null => (c.altitude_ft ? `${c.altitude_ft} ft${c.altitude_ref ? ` ${c.altitude_ref}` : ' (reference not stated)'}` : null)

/** The notes the source gives a drawn circuit ("At least 150 m AGL on downwind"), each with the circuit's name, once. The card shows them under the circuit list. */
export function circuitNotes(features: readonly DetailFeature[], aerodrome: string): string[] {
  const out: string[] = []
  for (const f of features) {
    const p = f.properties
    if (p.aerodrome !== aerodrome || p.kind !== 'circuit_leg' || p.schematic || f.geometry.type !== 'LineString' || !p.remarks) continue
    const line = p.name ? `${p.name}: ${p.remarks}` : p.remarks
    if (!out.includes(line)) out.push(line)
  }
  return out
}
const HAND_GLYPH = { left: '\u21B6', right: '\u21B7' } as const

/**
 * The circuits of an aerodrome grouped by runway end (in runway order), each entry "↶ left-hand · gliders", for the card. When two or more circuits give a height and all give the same one, the
 * height is stated once in `summary` ("Circuit height 1300 ft QNH") and left off the entries; otherwise each entry carries its own. Circuits for heavy aircraft only are listed (they are not drawn).
 */
export function circuitEndGroups(circuits: readonly CircuitInfo[]): { summary: string | null; ends: CircuitEndGroup[] } {
  const heights = circuits.map(heightOf).filter((h): h is string => !!h)
  const shared = heights.length >= 2 && new Set(heights).size === 1 ? heights[0]! : null
  const by = new Map<string, CircuitEntry[]>()
  for (const c of circuits) {
    const runway = c.runway.toUpperCase().replace(/^RWY\s*/, '').trim()
    const text = [
      c.direction ? `${HAND_GLYPH[c.direction]} ${c.direction}-hand` : 'direction not stated',
      shared ? null : heightOf(c),
      c.aircraft ? (AIRCRAFT_LABEL[c.aircraft] ?? c.aircraft) : null,
    ].filter(Boolean).join(' \u00B7 ')
    const list = by.get(runway) ?? []
    if (!list.some(e => e.text === text)) list.push({ direction: c.direction, text })
    by.set(runway, list)
  }
  const ends = [...by.entries()].map(([runway, entries]) => ({ runway, entries }))
    .sort((a, b) => (parseInt(a.runway, 10) || 99) - (parseInt(b.runway, 10) || 99) || a.runway.localeCompare(b.runway))
  return { summary: shared ? `Circuit height ${shared}` : null, ends }
}

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
    const groups = new Map<string, { arrow: TurnArrow; direction: 'left' | 'right'; groups: Set<CircuitGroup>; forAll: boolean }>()
    for (const c of info.circuits.filter(isDrawnCircuit)) {
      const arrow = circuitTurnArrow(runways, c)
      if (!arrow) continue
      const hit = findThreshold(runways, c)!
      const key = `${hit.r}|${hit.i}|${c.direction}`
      const g = groups.get(key) ?? { arrow, direction: c.direction!, groups: new Set<CircuitGroup>(), forAll: false }
      if (c.aircraft && GROUP_LABEL[c.aircraft]) g.groups.add(c.aircraft as CircuitGroup); else g.forAll = true
      groups.set(key, g)
    }
    const pending = info.provenance['circuits']?.review === 'pending'
    const provenance = info.provenance['circuits'] ? { provenance: info.provenance['circuits'] } : {}
    for (const g of groups.values()) {
      const name = [`RWY ${g.arrow.designator} ${SIDE[g.direction]}`, g.forAll ? null : [...g.groups].map(id => GROUP_LABEL[id]).join(', ')]
        .filter(Boolean).join(' · ')
      const only = !g.forAll && g.groups.size === 1 ? [...g.groups][0] : undefined
      const base = { aerodrome: id, kind: 'circuit_leg' as const, name, remarks: null, floor: null, ceiling: null,
        approximate: true, accuracy_m: null, pending, schematic: true, rwys: `|${g.arrow.designator}|`,
        ...(only ? { aircraft: only } : {}), ...provenance }
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


// ── What a tap on an area or circuit line says ────────────────────────────

/** A short line per kind for when the source gives no remark of its own. Only what the kind itself means. */
const KIND_NOTE: Partial<Record<DetailKind, string>> = {
  noise_sensitive: 'Avoid overflight.',
  avoid_area: 'Avoid this area.',
  glider_area: 'Glider activity.',
  parachute_area: 'Parachute jumping.',
  model_area: 'Model aircraft flying.',
  arrival_route: 'Fly-in route drawn on the club map.',
}

export interface LocalAreaInfo {
  /** The aerodrome the area belongs to (ICAO or local id). */
  aerodrome: string
  /** Which kind of area or line this is. */
  areaKind: DetailKind
  /** "Noise-sensitive area" / "Circuit" */
  kindLabel: string
  name: string | null
  /** The source's own remark, else the kind's short note. */
  note: string | null
  limits: string | null
  /** Noise-sensitive areas: the height the rule applies below ("2500 ft AMSL"), null when no height is stated. */
  below: string | null
  /** The outline was read off a map or chart: `accuracyM` says how well (null = not stated). */
  approximate: boolean
  accuracyM: number | null
  pending: boolean
  source: string | null
}

/**
 * Popup content from the properties of a rendered details feature. MapLibre hands nested values back as JSON strings and
 * flat ones as they are, so `limits` and `source` are written flat by buildDetailsMapData. Null for features that have
 * no popup (turn arrows, labels, extra points).
 */
export function localAreaInfo(p: Record<string, unknown> | null | undefined): LocalAreaInfo | null {
  if (!p) return null
  const kind = p['kind'] as DetailKind
  if (!(AREA_KINDS.has(kind) || kind === 'circuit_leg' || kind === 'arrival_route') || p['role'] === 'turn' || p['role'] === 'label') return null
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const acc = Number(p['accuracy_m'])
  return {
    aerodrome: String(p['aerodrome'] ?? ''),
    areaKind: kind,
    kindLabel: DETAIL_KIND_LABEL[kind],
    name: str(p['name']),
    // A noise-sensitive area says "Avoid overflight" and, when a height is stated, "below <height>". Nothing else is claimed:
    // a missing height means no height is known, not that the rule applies at every height.
    note: kind === 'noise_sensitive' && str(p['below']) ? `Avoid overflight below ${str(p['below'])}.` : str(p['remarks']) ?? KIND_NOTE[kind] ?? null,
    limits: str(p['limits']),
    below: str(p['below']),
    approximate: p['approximate'] === true || p['approximate'] === 'true',
    accuracyM: Number.isFinite(acc) && acc > 0 ? Math.round(acc) : null,
    pending: p['pending'] === true || p['pending'] === 'true',
    source: str(p['source']),
  }
}
