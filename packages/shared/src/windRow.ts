/**
 * windRow — placement of the single wind-barb row just under the Virtual
 * Radar's distance axis (METAR station barbs and ground-model barbs together).
 *
 * The row shares its vertical band with the x-axis tick labels. A barb stays
 * at its true route position and degrades instead of moving: first it is drawn
 * with its "dir/kt" text; if that would overlap a tick label, another barb or
 * the chart edge, it is drawn as the barb alone; if even that overlaps, it is
 * not drawn at all.
 *
 * Pass only the tick labels that must win in `tickPx` (or none): with a tick
 * every 100 px or so, letting every tick label beat the barbs hides most of
 * the row. `tickLabelsClearOfWindRow` then tells the caller which remaining
 * tick labels to hide because a placed barb or its text sits on them.
 */

export interface WindRowItem {
  key: string
  /** Wanted x in px from the plot's left edge. */
  px: number
  /** Width of the dir/kt text in px (0 = no text for this item). */
  labelW: number
  /** Lower number wins a contested spot (observed station = 0, model = 1). */
  priority: number
}

export interface WindRowPlaced {
  key: string
  px: number
  /** Side the text goes on, or null for barb only. */
  label: 'right' | 'left' | null
}

export interface WindRowOpts {
  /** Tick label centres, px from the plot's left edge. */
  tickPx: number[]
  /** Smallest / largest x a barb may sit at. */
  minPx: number
  maxPx: number
  /** Text must stay inside [leftLimitPx, rightLimitPx]. */
  leftLimitPx: number
  rightLimitPx: number
}

const BARB_HALF_PX = 9
const TEXT_GAP_PX = 4
const TICK_HALF_PX = 12

type Span = [number, number]
const overlaps = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1]

export function layoutWindRow(items: WindRowItem[], o: WindRowOpts): WindRowPlaced[] {
  const taken: Span[] = o.tickPx.map((t) => [t - TICK_HALF_PX, t + TICK_HALF_PX])
  const out = new Map<string, WindRowPlaced>()
  const order = [...items].sort((a, b) => a.priority - b.priority || a.px - b.px)

  for (const it of order) {
    if (it.px < o.minPx || it.px > o.maxPx) continue
    const x = it.px
    const right: Span = [x - BARB_HALF_PX, x + BARB_HALF_PX + TEXT_GAP_PX + it.labelW]
    const left: Span  = [x - BARB_HALF_PX - TEXT_GAP_PX - it.labelW, x + BARB_HALF_PX]
    const bare: Span  = [x - BARB_HALF_PX, x + BARB_HALF_PX]
    const free = (s: Span) => !taken.some((t) => overlaps(s, t))

    let placed: WindRowPlaced | null = null
    if (it.labelW > 0 && right[1] <= o.rightLimitPx && free(right)) placed = { key: it.key, px: x, label: 'right' }
    else if (it.labelW > 0 && left[0] >= o.leftLimitPx && free(left)) placed = { key: it.key, px: x, label: 'left' }
    else if (free(bare)) placed = { key: it.key, px: x, label: null }
    if (!placed) continue
    taken.push(placed.label === 'right' ? right : placed.label === 'left' ? left : bare)
    out.set(it.key, placed)
  }
  return items.flatMap((i) => (out.has(i.key) ? [out.get(i.key)!] : []))
}

/**
 * For each tick label centre in `tickPx`, whether it is clear of every placed
 * barb (and its text). Labels that aren't should be skipped by the caller;
 * the grid line can stay.
 */
export function tickLabelsClearOfWindRow(tickPx: number[], items: WindRowItem[], placed: WindRowPlaced[]): boolean[] {
  const labelW = new Map(items.map((i) => [i.key, i.labelW]))
  const spans: Span[] = placed.map((p) => {
    const w = labelW.get(p.key) ?? 0
    return p.label === 'right' ? [p.px - BARB_HALF_PX, p.px + BARB_HALF_PX + TEXT_GAP_PX + w]
      : p.label === 'left' ? [p.px - BARB_HALF_PX - TEXT_GAP_PX - w, p.px + BARB_HALF_PX]
      : [p.px - BARB_HALF_PX, p.px + BARB_HALF_PX]
  })
  return tickPx.map((t) => !spans.some((s) => overlaps([t - TICK_HALF_PX, t + TICK_HALF_PX], s)))
}
