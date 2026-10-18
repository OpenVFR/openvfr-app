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
