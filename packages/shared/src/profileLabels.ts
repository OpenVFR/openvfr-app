/**
 * Waypoint-name label selection for the Virtual Radar / Vertical Profile
 * (web VirtualRadar.tsx, native VerticalProfile.tsx).
 *
 * Labels are variable-width and the destination label is placed differently
 * from the others (clamped / right-aligned toward the left so it stays
 * inside the chart), so spacing the ticks by a fixed distance is not enough:
 * the destination label could land on the previous label even when the
 * ticks themselves were far apart. This works on the real label rectangles.
 */

export type LabelRect = { left: number; right: number }

/** Estimated label width in px for a 10 px font (about 5.2 px per character
 *  plus padding). Native truncates its labels at 60 px (the default cap);
 *  web draws them in full and passes `Infinity`. */
export function estimateLabelWidth(name: string, maxPx = 60): number {
  return Math.min(maxPx, Math.ceil(name.length * 5.2) + 2)
}

/**
 * Indices of the labels to draw, left to right.
 *
 * - `rects[0]` is the departure, which is never drawn (it sits on the Y
 *   axis); it is skipped but still counts as the left boundary at `minLeft`.
 * - A label is kept when it clears the last kept one by `gap` px and
 *   starts at or after `minLeft + gap`.
 * - The last label (the destination) always wins: any earlier kept labels
 *   that it would cover are dropped, so the destination name is never lost.
 */
export function pickWaypointLabels(rects: readonly LabelRect[], minLeft: number, gap = 1): number[] {
  const kept: number[] = []
  const lastIdx = rects.length - 1
  for (let i = 1; i < rects.length; i++) {
    const r = rects[i]
    if (i === lastIdx) {
      while (kept.length > 0 && rects[kept[kept.length - 1]].right + gap > r.left) kept.pop()
      kept.push(i)
      continue
    }
    const prevRight = kept.length > 0 ? rects[kept[kept.length - 1]].right : minLeft
    if (r.left < prevRight + gap) continue
    kept.push(i)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Rectangle label placement (obstacle names, aerodrome / navaid / reporting
// point names). Each label tries a few spots around its symbol and takes the
// first one that touches neither another label, any symbol, nor the chart edge;
// if none is free it is not drawn. Labels are placed by priority, so the
// important ones keep the best spot and the rest fit around them.
// ---------------------------------------------------------------------------

export type BoxRect = { left: number; top: number; right: number; bottom: number }

export interface LabelRequest {
  id: string
  /** Symbol anchor x (px). */
  x: number
  /** Top and bottom (px, y down) of the symbol this label names. */
  top: number
  bottom: number
  /** Symbol half width, so side-shifted labels clear it. */
  halfW: number
  /** Label box size (px). */
  w: number
  h: number
  priority: number
}

/** Where to draw a label: left edge x, text baseline y (draw with text-anchor start). */
export interface PlacedLabel { left: number; baseline: number }

const overlaps = (a: BoxRect, b: BoxRect, pad: number) =>
  a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad

/**
 * Greedy placement by priority (highest first, then left to right). Candidate
 * spots, in order: above centred, below centred, above/below shifted to the
 * right and to the left of the symbol, then a second row above and below.
 * `avoid` holds every symbol (and anything else that must stay readable);
 * placed labels are added to it as it goes. `bounds` is the area labels may use.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  avoid: readonly BoxRect[],
  bounds: BoxRect,
  pad = 1,
): Map<string, PlacedLabel> {
  const out = new Map<string, PlacedLabel>()
  const taken: BoxRect[] = [...avoid]
  const order = [...requests].sort((a, b) => b.priority - a.priority || a.x - b.x)
  for (const r of order) {
    if (r.w > bounds.right - bounds.left) continue
    const aboveBottom = r.top - 2
    const belowTop = r.bottom + 2
    const spots: { left: number; top: number }[] = []
    const mid = r.x - r.w / 2
    const right = r.x + r.halfW
    const left = r.x - r.halfW - r.w
    for (const row of [0, 1]) {
      const aTop = aboveBottom - r.h - row * (r.h + 1)
      const bTop = belowTop + row * (r.h + 1)
      spots.push({ left: mid, top: aTop }, { left: mid, top: bTop })
      if (row === 0) spots.push({ left: right, top: aTop }, { left, top: aTop }, { left: right, top: bTop }, { left, top: bTop })
    }
    for (const s of spots) {
      // Slide into the usable area instead of discarding a label that only pokes out sideways.
      const l = Math.max(bounds.left, Math.min(bounds.right - r.w, s.left))
      const box: BoxRect = { left: l, top: s.top, right: l + r.w, bottom: s.top + r.h }
      if (box.top < bounds.top || box.bottom > bounds.bottom) continue
      if (taken.some((t) => overlaps(box, t, pad))) continue
      taken.push(box)
      out.set(r.id, { left: l, baseline: box.bottom - 2 })
      break
    }
  }
  return out
}

/** Label box widths (px) of obstacle (12 px bold) and POI (11 px) names, shared by placement and drawing.
 *  Generous on purpose: native cannot measure text synchronously, and bold text with its halo runs wider
 *  than the 5.2 px/char estimate. A label may leave a little extra room, but never touches a neighbour. */
export const obstacleLabelWidth = (label: string) => Math.ceil(estimateLabelWidth(label, Infinity) * 1.35)
export const poiLabelWidth = (label: string) => Math.ceil(estimateLabelWidth(label, Infinity) * 1.15)
/** Width (px) of a waypoint name drawn at 12 px semibold (~6.8 px per character): used to decide which
 *  names fit side by side. Deliberately generous and uncapped, so a long name never runs into its neighbour. */
export const waypointLabelWidth = (name: string) => Math.ceil(name.length * 6.8) + 6
export const OBSTACLE_LABEL_H = 15
export const POI_LABEL_H = 13

/**
 * Limiting obstacles close together (a wind farm) share one label: the one with the
 * highest priority keeps it, the others are counted ("+1") instead of stacking names.
 * Mutates `label` of the given marks.
 */
export function mergeNearbyLabels(marks: { key: string; cx: number; priority: number; label: string }[], mergePx: number): void {
  const merged = new Map<string, number>()
  const kept: typeof marks = []
  for (const m of marks.filter((x) => x.label).sort((a, b) => b.priority - a.priority)) {
    const host = kept.find((k) => Math.abs(k.cx - m.cx) < mergePx)
    if (host) { merged.set(host.key, (merged.get(host.key) ?? 0) + 1); m.label = '' } else kept.push(m)
  }
  kept.forEach((k) => { const n = merged.get(k.key); if (n) k.label += ` +${n}` })
}

/**
 * Places the obstacle and POI names. Names keep clear of symbols, airspace chips and
 * clouds when there is room. A `mustShow` name (a limiting obstacle's warning must not
 * vanish) that finds no such spot is first lifted into free sky above its symbol, joined
 * by a leader line, then retried with fewer constraints: clouds dropped first, then chips.
 */
export function placeRadarLabels(o: {
  requests: readonly LabelRequest[]
  /** Every symbol: always avoided. */
  symbols: readonly BoxRect[]
  chips: readonly BoxRect[]
  clouds: readonly BoxRect[]
  area: BoxRect
  mustShow: (id: string) => boolean
}): { placed: Map<string, PlacedLabel>; leaders: Set<string> } {
  const { requests, symbols, chips, clouds, area, mustShow } = o
  const allBoxes = [...symbols, ...chips, ...clouds]
  const placed = placeLabels(requests, allBoxes, area)
  const boxOf = (r: LabelRequest, pl: PlacedLabel): BoxRect => ({ left: pl.left, right: pl.left + r.w, top: pl.baseline + 2 - r.h, bottom: pl.baseline + 2 })
  const placedBoxes = () => requests.filter((r) => placed.has(r.id)).map((r) => boxOf(r, placed.get(r.id)!))
  const leaders = new Set<string>()
  // Crowded near the ground: lift the name into free sky above, joined by a leader line.
  for (const r of requests.filter((q) => !placed.has(q.id) && mustShow(q.id))) {
    for (let lift = r.h + 8; lift < area.bottom - area.top; lift += r.h + 3) {
      const got = placeLabels([{ ...r, top: r.top - lift, bottom: r.top - lift }], [...allBoxes, ...placedBoxes()], area)
      if (got.size) { placed.set(r.id, got.get(r.id)!); leaders.add(r.id); break }
    }
  }
  // Last resort: fewer constraints, clouds first, then chips.
  for (const tier of [[...symbols, ...chips], symbols]) {
    const missing = requests.filter((q) => !placed.has(q.id) && mustShow(q.id))
    if (missing.length === 0) break
    placeLabels(missing, [...tier, ...placedBoxes()], area).forEach((v, k) => placed.set(k, v))
  }
  return { placed, leaders }
}
