/**
 * Cloud-layer glyphs for the vertical profile chart (web VirtualRadar,
 * native VerticalProfile).
 *
 * A METAR/TAF cloud group tells us three things: cover in oktas
 * (FEW/SCT/BKN/OVC), base height, and sometimes a convective type
 * (CB/TCU). It says nothing about tops, horizontal extent or shape, and it
 * is a point observation at one station. The glyph is built to encode only
 * those facts:
 *   - a flat bottom at the reported base (the one altitude we know),
 *   - lumpy tops of FIXED pixel height, so they carry no altitude meaning,
 *   - cover expressed as how much of the station's strip holds cloud
 *     (FEW: one small cloud ... OVC: one continuous layer),
 *   - CB/TCU drawn as a tower (TCU) or tower + anvil (CB) in a warning colour.
 *
 * Pure geometry in screen pixels (y grows downward), returning SVG path
 * strings so web (plain SVG) and native (react-native-svg) render the same
 * shapes from the same numbers.
 */

import type { ParsedCloudLayer } from './fetchWx'

export type CloudCover = ParsedCloudLayer['cover']
export type CloudType = NonNullable<ParsedCloudLayer['type']>

interface CloudStyle {
  /** Share of the station strip covered by cloud. */
  fraction: number
  /** Separate cloud bodies spread across the strip. */
  clusters: number
  /** Cap on lump height above the body, px. */
  bumpH: number
  /** Flat body thickness above the base, px. */
  bodyH: number
  /** Target lump width, px — sets how many lumps a cloud gets. */
  chord: number
}

const CLOUD_STYLE: Record<CloudCover, CloudStyle> = {
  FEW: { fraction: 0.40, clusters: 1, bumpH: 11, bodyH: 2, chord: 9 },
  SCT: { fraction: 0.60, clusters: 2, bumpH: 10, bodyH: 2, chord: 9 },
  BKN: { fraction: 0.88, clusters: 3, bumpH: 9,  bodyH: 3, chord: 9 },
  OVC: { fraction: 1.00, clusters: 1, bumpH: 5,  bodyH: 5, chord: 9 },
}

/** Tallest a plain (non-convective) glyph gets above its base, px. */
export const CLOUD_GLYPH_H = 14
/** Height of the TCU tower / CB anvil top above the base, px. */
export const CONVECTIVE_GLYPH_H = 28

/** Stations further than this from the route (cross-track, plus any
 *  nearest-station fallback distance) don't get clouds drawn at all: at that
 *  range the report says little about the sky over the route itself. */
export const CLOUD_MAX_OFF_ROUTE_NM = 10
/** Full opacity up to this cross-track distance, fading toward the limit. */
const CLOUD_FADE_START_NM = 3
const CLOUD_MIN_OPACITY = 0.45

/** Opacity multiplier for a report taken `offRouteNm` from the route, or 0
 *  when it is too far away to draw. */
export function cloudOpacityForOffset(offRouteNm: number): number {
  if (!(offRouteNm >= 0) || offRouteNm > CLOUD_MAX_OFF_ROUTE_NM) return 0
  if (offRouteNm <= CLOUD_FADE_START_NM) return 1
  const t = (offRouteNm - CLOUD_FADE_START_NM) / (CLOUD_MAX_OFF_ROUTE_NM - CLOUD_FADE_START_NM)
  return 1 - t * (1 - CLOUD_MIN_OPACITY)
}

/** The station whose report a route weather entry actually carries: an
 *  aerodrome without its own METAR borrows the nearest one (`sourceIcao`). */
export interface CloudReportSource {
  icao: string
  sourceIcao?: string
  sourceDistNm?: number | null
}

/** How far from the route the cloud report was really taken: the entry's
 *  own cross-track distance, plus the borrow distance when its report came
 *  from another station (a conservative upper bound — that station may sit
 *  closer to the route, but never further than this). */
export function cloudReportOffRouteNm(offRouteNm: number, s: CloudReportSource): number {
  const borrowed = s.sourceIcao != null && s.sourceIcao !== s.icao
  return offRouteNm + (borrowed ? (s.sourceDistNm ?? Infinity) : 0)
}

/** ICAO code to print on the label: the station the report came from. */
export function cloudReportIcao(s: CloudReportSource): string {
  return s.sourceIcao ?? s.icao
}

/** Half-width (NM) of the strip a station's clouds are drawn across. A
 *  fixed-width strip around the station rather than an interpolation
 *  between stations, which would imply false precision. */
export function cloudStripHalfWidthNm(totalNm: number): number {
  return Math.min(totalNm * 0.06, 4)
}

/** Visual height of a layer's glyph above its base, px. */
export function cloudGlyphHeight(layer: Pick<ParsedCloudLayer, 'type'>): number {
  return layer.type ? CONVECTIVE_GLYPH_H : CLOUD_GLYPH_H
}

/** METAR-style label for one layer, e.g. "BKN015", "SCT040CB". */
export function cloudLayerLabel(layer: ParsedCloudLayer): string {
  return `${layer.cover}${String(Math.round(layer.baseFt / 100)).padStart(3, '0')}${layer.type ?? ''}`
}

/** Deterministic 0..1 jitter so a given station draws the same lumps every
 *  render (no flicker on re-render). */
function jitter(seed: number, i: number): number {
  const v = Math.sin((seed + 1) * 12.9898 + i * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** Semicircle-or-flatter arc from the current point to (x, y), bulging up.
 *  Capped at a half circle so neighbouring lumps only touch and no outline
 *  arc shows through a translucent fill. */
function lumpArc(c: number, h: number, x: number, y: number): string {
  const hh = Math.max(0.5, Math.min(c / 2, h))
  const r = (hh * hh + (c * c) / 4) / (2 * hh)
  return ` A${r},${r} 0 0 1 ${x},${y}`
}

/** A row of lumps from the current point (at xStart) to xEnd on baseline y.
 *  Height variety comes from width: middle lumps get a wider (hence
 *  taller) chord, plus a little per-seed jitter. */
function lumpRow(xStart: number, xEnd: number, y: number, n: number, hCap: number, seed: number): string {
  const w = xEnd - xStart
  if (w <= 1 || n < 1) return ` L${xEnd},${y}`
  const weights = Array.from({ length: n }, (_, b) => {
    const mid = 1 - Math.abs((b + 0.5) / n - 0.5) * 2
    return 0.6 + 0.8 * mid + 0.25 * jitter(seed, b)
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let d = ''
  let x = xStart
  for (const wt of weights) {
    const c = (w * wt) / total
    x += c
    d += lumpArc(c, hCap, x, y)
  }
  return d
}

/** Share of a convective cloud's width taken by its tower. */
const TOWER_FRACTION = 0.42

/**
 * One cloud body from x0..x1 standing on yBase. With `type`, a tower rises
 * from the middle: a column with a lumpy crown (TCU) or with a flat anvil
 * overhanging both sides (CB).
 */
function cloudBodyPath(
  x0: number, x1: number, yBase: number, seed: number, st: CloudStyle,
  type: CloudType | undefined, vScale: number,
): string {
  const w = x1 - x0
  if (w <= 2) return ''
  const shoulder = yBase - st.bodyH * vScale
  const bumpH = st.bumpH * vScale
  let d = `M${x0},${yBase} L${x0},${shoulder}`
  if (!type) {
    d += lumpRow(x0, x1, shoulder, Math.max(3, Math.round(w / st.chord)), bumpH, seed)
  } else {
    const tw = Math.max(10, w * TOWER_FRACTION)
    const cx = (x0 + x1) / 2
    const tx0 = cx - tw / 2, tx1 = cx + tw / 2
    const nSide = Math.max(1, Math.round((tx0 - x0) / st.chord))
    const top = yBase - CONVECTIVE_GLYPH_H * vScale
    d += lumpRow(x0, tx0, shoulder, nSide, bumpH, seed)
    if (type === 'CB') {
      const overhang = tw * 0.6
      const anvilT = 4 * vScale
      const neck = top + anvilT + 3 * vScale
      d += ` L${tx0},${neck} L${tx0 - overhang},${top + anvilT} L${tx0 - overhang + 2},${top}`
      d += ` L${tx1 + overhang - 2},${top} L${tx1 + overhang},${top + anvilT} L${tx1},${neck}`
    } else {
      // Crown of three lumps; the middle one gets the widest chord, so the
      // crown peaks at `top` with lumps up to a half circle tall.
      const crownH = tw / 4
      d += ` L${tx0},${top + crownH}`
      d += lumpRow(tx0, tx1, top + crownH, 3, crownH, seed + 11)
    }
    d += ` L${tx1},${shoulder}`
    d += lumpRow(tx1, x1, shoulder, nSide, bumpH, seed + 5)
  }
  d += ` L${x1},${yBase} Z`
  return d
}

/**
 * SVG path(s) for one cloud layer across the station strip x1..x2 (px),
 * standing on yBase (px). `maxH` caps the glyph's height (e.g. distance to
 * the top of the plot) by squashing it vertically rather than clipping.
 */
export function cloudLayerPaths(
  x1: number, x2: number, yBase: number,
  layer: Pick<ParsedCloudLayer, 'cover' | 'type'>,
  seed: number,
  maxH = Infinity,
): string[] {
  const st = CLOUD_STYLE[layer.cover]
  const vScale = Math.max(0.3, Math.min(1, maxH / cloudGlyphHeight(layer)))
  const W = x2 - x1
  const filled = W * st.fraction
  const n = st.clusters
  if (n === 1) {
    const c = (x1 + x2) / 2
    return [cloudBodyPath(c - filled / 2, c + filled / 2, yBase, seed, st, layer.type, vScale)]
  }
  const gap = (W - filled) / (n + 1)
  const cw = filled / n
  const centre = Math.floor(n / 2)
  const out: string[] = []
  for (let k = 0; k < n; k++) {
    const a = x1 + gap * (k + 1) + cw * k
    // Only the centre cluster carries the tower: one CB per report, not three.
    out.push(cloudBodyPath(a, a + cw, yBase, seed + k, st, k === centre ? layer.type : undefined, vScale))
  }
  return out
}

export interface LabelRect { x: number; y: number; w: number; h: number }

function overlaps(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Rough text width for the chart's 9px label font. */
export function cloudLabelWidth(text: string): number {
  return text.length * 5.3
}

/**
 * Baseline y for a cloud label centred on `cx`: under the base, else above
 * the glyph, else further under — the first spot that stays inside
 * [plotTop, plotBottom] and avoids every rect in `taken` (airspace chips,
 * earlier cloud labels). The chosen rect is pushed onto `taken` so later
 * labels avoid it too. Falls back to "under the base" if nothing is free.
 */
export function placeCloudLabel(
  cx: number, yBase: number, glyphH: number, text: string,
  taken: LabelRect[], plotTop: number, plotBottom: number,
): number {
  const w = cloudLabelWidth(text)
  const H = 10
  const rectFor = (baseline: number): LabelRect => ({ x: cx - w / 2, y: baseline - 8, w, h: H })
  const candidates = [yBase + 10, yBase - glyphH - 3, yBase + 21]
  const fits = (b: number) => b - 8 >= plotTop && b + 2 <= plotBottom
  const pick = candidates.find((b) => fits(b) && !taken.some((t) => overlaps(rectFor(b), t)))
    ?? candidates.find(fits)
    ?? candidates[0]
  taken.push(rectFor(pick))
  return pick
}
