/**
 * legAltitudes — the vertical picture of each leg for planning a level:
 * minimum safe altitude, controlled airspace over the leg (where along it,
 * floor, ceiling, frequency), control zones from the surface, restricted
 * areas and zones, and a suggested altitude that keeps terrain clearance,
 * stays below controlled airspace where it can, and follows the VFR
 * semicircular cruising levels (SERA.5005: above 3,000 ft above the ground,
 * magnetic track 000-179 odd thousands + 500 ft, 180-359 even + 500 ft).
 *
 * The leg is cut where controlled airspace starts or ends. When one altitude
 * cannot fit the whole leg but each part has one, it suggests changing level
 * between the parts; when terrain clearance reaches a floor it says so and
 * lists the options. It never suggests flying below the MSA.
 *
 * Pure: the caller supplies the profile bands (AGL limits already lifted onto
 * the terrain), the per-leg MSA, the MSA samples and terrain samples.
 */
import type { RouteWaypoint } from './routeCalc'
import { magneticBearingDeg } from './routeCalc'
import type { AirspaceCrossSection, MsaPoint, TerrainPoint } from './virtualRadarCalc'
import type { LegSpan } from './legLevelDrag'

/** Airspace classes that need an ATC clearance for VFR. */
const CLEARANCE_CLASSES = new Set(['A', 'B', 'C', 'D'])
const RESTRICTED = new Set(['R', 'TRA', 'P', 'D'])
const ZONES = new Set(['TMZ', 'RMZ'])
/** Stay this far below a controlled floor. */
export const FLOOR_BUFFER_FT = 200
/** Highest altitude suggested (VFR piston planning); airspace above is not listed. */
const MAX_SUGGEST_FT = 12_500
/** Semicircular levels apply above this height over the ground. */
const SEMICIRCULAR_AGL_FT = 3000
/** Parts of a leg shorter than this are not planned separately. */
const MIN_PART_NM = 2

export interface LegAirspace {
  name: string
  cls: string
  type: string
  lowerFt: number
  upperFt: number
  freq?: string
  /** Where along the leg (NM from its start) it lies. */
  fromNm: number
  toNm: number
}

export interface LegPart {
  fromNm: number
  toNm: number
  msaFt: number
  /** Lowest controlled floor above this part (null = none). */
  floorFt: number | null
  floorName?: string
  /** Lowest sensible level here (null = none fits below the floor). */
  levelFt: number | null
}

export type LegAdvice =
  | { kind: 'ok'; suggestedFt: number; text: string }
  | { kind: 'split'; parts: LegPart[]; text: string }
  | { kind: 'conflict'; suggestedFt: number; text: string }
  | { kind: 'unknown'; text: string }

/** An obstacle or landmark top along the route, for naming what sets the MSA. */
export interface MsaTip {
  distNm: number
  tipFt: number
  kind: string
  name: string
  /** Distance off the route line, NM (unknown for landmarks). */
  lateralNm?: number
  estimated: boolean
}

export interface LegAltitude {
  /** 1-based leg number. */
  leg: number
  from: string
  to: string
  lengthNm: number
  magneticTrackDeg: number
  plannedFt: number
  /** Minimum safe altitude (0 = no terrain data). */
  msaFt: number
  /** False near departure and destination, where flying below the MSA is normal. */
  msaApplies: boolean
  /** What sets the MSA: the highest terrain or the obstacle top, in words (null = unknown). */
  msaCause: string | null
  /** Lowest ground under the leg (null = unknown). */
  groundMinFt: number | null
  /** Lowest floor (above the surface) of airspace needing a clearance over the leg (null = none). */
  controlledFloorFt: number | null
  /** Airspace needing a clearance with a floor above the surface (TMAs, sectors). */
  controlled: LegAirspace[]
  /** Airspace needing a clearance from the surface up (control zones). */
  fromSurface: LegAirspace[]
  restricted: LegAirspace[]
  zones: LegAirspace[]
  /** The planned altitude against terrain and airspace. */
  planned: string[]
  /** Whether the VFR semicircular cruising levels apply at the planned altitude, in words. */
  cruisingRule: string
  /** Control zones crossed at any altitude, and what to do. */
  notes: string[]
  advice: LegAdvice
}

/** Valid VFR cruising altitude for the track (only checked above 3,000 ft AGL). */
export function isSemicircularLevel(altFt: number, magneticTrackDeg: number): boolean {
  if (altFt % 1000 !== 500) return false
  const thousands = Math.floor(altFt / 1000)
  return magneticTrackDeg < 180 ? thousands % 2 === 1 : thousands % 2 === 0
}

/** Lowest altitude >= minFt that is a sensible planning level: a multiple of
 *  500 ft, and a semicircular level wherever it is more than 3,000 ft above
 *  the lowest ground (`groundFt`). */
export function lowestLevelAtOrAbove(minFt: number, magneticTrackDeg: number, groundFt: number | null): number {
  let alt = Math.max(500, Math.ceil(minFt / 500) * 500)
  for (; alt <= 20_000; alt += 500) {
    const agl = alt - (groundFt ?? 0)
    if (agl <= SEMICIRCULAR_AGL_FT || isSemicircularLevel(alt, magneticTrackDeg)) return alt
  }
  return alt
}

const fmt = (ft: number) => `${ft.toLocaleString('en-US')} ft`
const span = (from: number, to: number, len: number) =>
  from <= 0.5 && to >= len - 0.5 ? 'the whole leg' : `NM ${Math.round(from)}-${Math.round(to)} of the leg`
const where = (a: { fromNm: number; toNm: number }, len: number) => span(a.fromNm, a.toNm, len)
const label = (a: LegAirspace) => `${a.name} (class ${a.cls}, ${fmt(a.lowerFt)}-${fmt(a.upperFt)}${a.freq ? `, ${a.freq}` : ''})`
const covers = (a: LegAirspace, from: number, to: number) => a.fromNm <= from + 0.01 && a.toNm >= to - 0.01

function maxMsa(msaPts: readonly MsaPoint[], from: number, to: number): number {
  let max = 0
  let before = 0
  for (const p of msaPts) {
    if (p.distNm <= from) before = p.msaFt
    if (p.distNm >= from - 0.01 && p.distNm <= to + 0.01 && p.msaFt > max) max = p.msaFt
  }
  // A part shorter than the sample spacing: the step value in force there.
  return Math.max(max, before)
}

export function legAltitudes(input: {
  waypoints: readonly RouteWaypoint[]
  spans: readonly LegSpan[]
  bands: readonly AirspaceCrossSection[]
  legMsaFt: readonly number[]
  msaApplies: readonly boolean[]
  /** MSA samples along the route (for the parts of a leg); [] = none. */
  msaPts?: readonly MsaPoint[]
  /** Terrain samples along the route (DEM, or the grid when that failed); [] = none. */
  terrain: readonly TerrainPoint[]
  /** Highest grid terrain in each terrain sample's stretch of the corridor (same indexing). */
  corridorFt?: readonly (number | null)[]
  /** Obstacle and landmark tops along the route, and the MSA margins, to name what sets the MSA. */
  tips?: readonly MsaTip[]
  margins?: { terrainClearanceFt: number; obstacleClearanceFt: number; abeamNm: number }
}): LegAltitude[] {
  const { waypoints, spans, bands } = input
  const lastLeg = spans.length - 1
  return spans.map((s, i) => {
    const a = waypoints[s.legIndex]!, b = waypoints[s.legIndex + 1]!
    const len = s.toNm - s.fromNm
    const track = Math.round(magneticBearingDeg(a, b))
    const msa = input.legMsaFt[i] ?? 0
    const applies = input.msaApplies[i] ?? true
    let groundMin: number | null = null
    for (const p of input.terrain) {
      if (p.distNm < s.fromNm - 0.01 || p.distNm > s.toNm + 0.01) continue
      if (groundMin === null || p.elevFt < groundMin) groundMin = p.elevFt
    }

    // ── What sets the MSA ──────────────────────────────────────────────────
    let msaCause: string | null = null
    if (msa > 0 && input.margins) {
      const m = input.margins
      let terrainMax = -1, terrainAt = 0, fromGrid = false
      input.terrain.forEach((p, k) => {
        if (p.distNm < s.fromNm - 0.01 || p.distNm > s.toNm + 0.01) return
        if (p.elevFt > terrainMax) { terrainMax = p.elevFt; terrainAt = p.distNm; fromGrid = false }
        const c = input.corridorFt?.[k]
        if (c != null && c > terrainMax) { terrainMax = c; terrainAt = p.distNm; fromGrid = true }
      })
      let tip: MsaTip | null = null
      for (const t of input.tips ?? []) {
        if (t.distNm < s.fromNm - m.abeamNm || t.distNm > s.toNm + m.abeamNm) continue
        if (!tip || t.tipFt > tip.tipFt) tip = t
      }
      const byTerrain = terrainMax >= 0 ? terrainMax + m.terrainClearanceFt : 0
      const byTip = tip ? tip.tipFt + m.obstacleClearanceFt : 0
      const at = (d: number) => d < s.fromNm ? 'before the start of the leg' : d > s.toNm ? 'past the end of the leg' : `at NM ${Math.round(d - s.fromNm)} of the leg`
      if (tip && byTip >= byTerrain) {
        const named = (tip.name.replace(/^[\w-]*\d[\w-]*\s*-\s*/, '').trim().replace(/[^\p{L}\p{N} .,/()'-]/gu, '').slice(0, 40))
        const what = named ? `${named} (${tip.kind.replace(/_/g, ' ')})` : `a ${tip.kind.replace(/_/g, ' ')}`
        msaCause = `${what}, top ${fmt(tip.tipFt)}${tip.estimated ? ' (height estimated)' : ''}, ${at(tip.distNm)}${tip.lateralNm != null ? `, ${tip.lateralNm.toFixed(1)} NM from the track` : ''}, + ${fmt(m.obstacleClearanceFt)} clearance`
      } else if (terrainMax >= 0) {
        msaCause = `terrain up to ${fmt(Math.round(terrainMax))} within ${m.abeamNm} NM of the track ${fromGrid ? `around NM ${Math.round(terrainAt - s.fromNm)}` : at(terrainAt)}, + ${fmt(m.terrainClearanceFt)} clearance`
      }
    }

    const over: LegAirspace[] = bands
      .filter(x => x.exitNm > s.fromNm + 0.05 && x.entryNm < s.toNm - 0.05)
      .map(x => ({
        // Published names, but shown to assistants' models: letters, digits and plain punctuation only.
        name: x.name.replace(/[^\p{L}\p{N} .,/()'-]/gu, '').slice(0, 60), cls: x.class, type: x.type,
        lowerFt: Math.round(x.lower_ft), upperFt: Math.round(x.upper_ft),
        ...(x.freq ? { freq: x.freq } : {}),
        fromNm: Math.max(0, x.entryNm - s.fromNm), toNm: Math.min(len, x.exitNm - s.fromNm),
      }))
      .filter(x => x.lowerFt < MAX_SUGGEST_FT)
    const clearance = over.filter(x => CLEARANCE_CLASSES.has(x.cls))
    const fromSurface = clearance.filter(x => x.lowerFt <= 0)
    const controlled = clearance.filter(x => x.lowerFt > 0).sort((p, q) => p.lowerFt - q.lowerFt)
    const restricted = over.filter(x => RESTRICTED.has(x.cls) || RESTRICTED.has(x.type))
    const zones = over.filter(x => ZONES.has(x.cls) || ZONES.has(x.type))
    const floor = controlled.length ? controlled[0]!.lowerFt : null

    // ── Control zones: a clearance at any altitude ────────────────────────
    const notes: string[] = []
    for (const z of fromSurface) {
      const atDeparture = i === 0 && z.fromNm <= 0.5
      const atArrival = i === lastLeg && z.toNm >= len - 0.5
      notes.push(atDeparture || atArrival
        ? `${atDeparture ? 'Departure' : 'Arrival'} through ${label(z)}: clearance as usual.`
        : `Crosses ${label(z)} on ${where(z, len)}: a clearance is needed at any altitude below ${fmt(z.upperFt)}${z.upperFt < MAX_SUGGEST_FT ? ', or fly above it' : ''}, or route around it.`)
    }

    // ── The planned altitude ───────────────────────────────────────────────
    const planned: string[] = []
    if (msa > 0 && applies && s.altFt < msa) planned.push(`${fmt(s.altFt)} is below the MSA of ${fmt(msa)}`)
    for (const c of controlled) {
      if (s.altFt >= c.lowerFt && s.altFt < c.upperFt) planned.push(`${fmt(s.altFt)} is inside ${label(c)} on ${where(c, len)}: needs a clearance`)
      else if (s.altFt < c.lowerFt && c.lowerFt - s.altFt < FLOOR_BUFFER_FT) planned.push(`${fmt(s.altFt)} is only ${c.lowerFt - s.altFt} ft below the floor of ${label(c)} on ${where(c, len)}: keep at least ${FLOOR_BUFFER_FT} ft below it`)
    }
    for (const r of restricted) {
      if (s.altFt >= r.lowerFt && s.altFt < r.upperFt) planned.push(`${fmt(s.altFt)} is inside ${r.name} (${r.cls}) on ${where(r, len)}: check whether it is active`)
    }
    if (msa > 0 && applies && s.altFt - (groundMin ?? 0) > SEMICIRCULAR_AGL_FT && !isSemicircularLevel(s.altFt, track)) {
      planned.push(`${fmt(s.altFt)} is not a VFR cruising level for magnetic track ${track}° (use ${track < 180 ? 'odd' : 'even'} thousands + 500 ft above 3,000 ft above the ground)`)
    }

    // ── Suggestion ─────────────────────────────────────────────────────────
    let advice: LegAdvice
    if (msa <= 0) {
      advice = { kind: 'unknown', text: 'No terrain data for this leg: no minimum safe altitude, so no altitude is suggested.' }
    } else {
      const nearEnds = applies ? '' : ' (MSA not applied this close to departure or destination: climb or descend by the published procedures)'
      const lowest = lowestLevelAtOrAbove(Math.max(applies ? msa : 0, 1000), track, groundMin)
      if (floor === null || lowest <= floor - FLOOR_BUFFER_FT) {
        const below = floor !== null ? `, below ${label(controlled[0]!)}` : ''
        advice = { kind: 'ok', suggestedFt: lowest, text: `${fmt(lowest)}: at or above the MSA of ${fmt(msa)}${below}${nearEnds}.` }
      } else {
        // Parts of the leg between controlled-airspace boundaries.
        const cuts = [...new Set([0, len, ...controlled.flatMap(c => [c.fromNm, c.toNm])])].filter(x => x >= 0 && x <= len).sort((p, q) => p - q)
        let parts: LegPart[] = []
        for (let k = 0; k + 1 < cuts.length; k++) {
          const from = cuts[k]!, to = cuts[k + 1]!
          if (to - from < 0.05) continue
          const above = controlled.filter(c => covers(c, from, to)).sort((p, q) => p.lowerFt - q.lowerFt)[0]
          const partMsa = applies ? (input.msaPts?.length ? maxMsa(input.msaPts, s.fromNm + from, s.fromNm + to) : msa) : 0
          const lvl = lowestLevelAtOrAbove(Math.max(partMsa, 1000), track, groundMin)
          parts.push({
            fromNm: from, toNm: to, msaFt: partMsa, floorFt: above ? above.lowerFt : null,
            ...(above ? { floorName: above.name } : {}),
            levelFt: !above || lvl <= above.lowerFt - FLOOR_BUFFER_FT ? lvl : null,
          })
        }
        // Merge short parts into a neighbour, keeping the stricter limits.
        parts = parts.reduce<LegPart[]>((acc, p) => {
          const prev = acc[acc.length - 1]
          if (prev && (p.toNm - p.fromNm < MIN_PART_NM || prev.toNm - prev.fromNm < MIN_PART_NM || prev.floorFt === p.floorFt)) {
            const floorFt = prev.floorFt === null ? p.floorFt : p.floorFt === null ? prev.floorFt : Math.min(prev.floorFt, p.floorFt)
            const msaFt = Math.max(prev.msaFt, p.msaFt)
            const lvl = lowestLevelAtOrAbove(Math.max(msaFt, 1000), track, groundMin)
            const floorName = floorFt === prev.floorFt ? prev.floorName : p.floorName
            acc[acc.length - 1] = { fromNm: prev.fromNm, toNm: p.toNm, msaFt, floorFt, ...(floorName ? { floorName } : {}), levelFt: floorFt === null || lvl <= floorFt - FLOOR_BUFFER_FT ? lvl : null }
          } else acc.push(p)
          return acc
        }, [])
        const blocked = parts.filter(p => p.levelFt === null)
        if (blocked.length === 0 && parts.length > 1) {
          advice = {
            kind: 'split', parts,
            text: `No single altitude fits the whole leg below controlled airspace. Change level on the way (add a point where it changes): ${parts.map(p => `${fmt(p.levelFt!)} on ${span(p.fromNm, p.toNm, len)}${p.floorFt !== null ? ` (below ${p.floorName} from ${fmt(p.floorFt)})` : ''}`).join(', then ')}. Or ask for a clearance and fly ${fmt(lowest)} throughout${nearEnds}.`,
          }
        } else {
          const p = blocked[0] ?? parts[0]!
          const c = controlled.find(x => x.name === p.floorName) ?? controlled[0]!
          const opts = [
            `ask ${c.name}${c.freq ? ` on ${c.freq}` : ''} for a clearance to fly at ${fmt(lowest)} or higher`,
            `route around it: it covers ${where(c, len)}`,
          ]
          advice = { kind: 'conflict', suggestedFt: lowest, text: `On ${span(p.fromNm, p.toNm, len)} the MSA of ${fmt(p.msaFt)} reaches ${label(c)}: no altitude there is both safe over terrain and outside it. Options: ${opts.join('; or ')}. Never fly below the MSA to stay out of it.` }
        }
      }
    }

    const agl = s.altFt - (groundMin ?? 0)
    const cruisingRule = groundMin === null
      ? 'VFR cruising levels: apply above 3,000 ft above the ground (ground height unknown here)'
      : agl > SEMICIRCULAR_AGL_FT
        ? `VFR cruising levels apply at ${fmt(s.altFt)} (more than 3,000 ft above the ground): magnetic track ${track}° needs ${track < 180 ? 'odd thousands + 500 ft (3,500, 5,500…)' : 'even thousands + 500 ft (4,500, 6,500…)'}`
        : `VFR cruising levels do not apply at ${fmt(s.altFt)} (not more than 3,000 ft above the ground, lowest ground ${fmt(Math.max(0, Math.round(groundMin)))})`

    return {
      cruisingRule,
      leg: s.legIndex + 1,
      from: a.name ?? `WP${s.legIndex + 1}`,
      to: b.name ?? `WP${s.legIndex + 2}`,
      lengthNm: Math.round(len * 10) / 10,
      magneticTrackDeg: track,
      plannedFt: s.altFt,
      msaFt: msa,
      msaApplies: applies,
      msaCause,
      groundMinFt: groundMin,
      controlledFloorFt: floor,
      controlled, fromSurface, restricted, zones,
      planned, notes,
      advice,
    }
  })
}
