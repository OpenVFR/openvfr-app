/**
 * windBarb — shared bucketing rule for the wind-barb map icons (web canvas-
 * drawn, native pre-rendered PNG set) used by the ambient "Wind Arrows"
 * overlay (see windGrid.ts). A single source of truth for the rounding
 * step so web's dynamic style expression and native's fixed asset lookup
 * always agree on which bucket a given speed maps to.
 *
 * WMO wind-barb convention: shaft length is fixed, speed is encoded by the
 * number/size of "feathers" (pennant = 50kt triangle, full barb = 10kt,
 * half barb = 5kt) — hence discretising into 5kt buckets rather than
 * continuously scaling icon-size like the old single-arrow icon did.
 */

export const WIND_BARB_STEP_KTS = 5
export const WIND_BARB_MIN_KTS = 0
export const WIND_BARB_MAX_KTS = 100

/** Rounds a raw speed to the nearest bucket this icon set supports. */
export function windBarbBucket(speedKts: number): number {
  const rounded = Math.round(speedKts / WIND_BARB_STEP_KTS) * WIND_BARB_STEP_KTS
  return Math.max(WIND_BARB_MIN_KTS, Math.min(WIND_BARB_MAX_KTS, rounded))
}

/** Icon id for a given raw speed, e.g. windBarbIconId(13) === 'wind-barb-15'. */
export function windBarbIconId(speedKts: number): string {
  return `wind-barb-${windBarbBucket(speedKts)}`
}

/** All bucket values this icon set covers (0, 5, 10, ..., 100) — used to
 * pre-register every possible icon id up front (native's static asset map;
 * web could use this too, but registers lazily via styleimagemissing instead). */
export function allWindBarbBuckets(): number[] {
  const out: number[] = []
  for (let b = WIND_BARB_MIN_KTS; b <= WIND_BARB_MAX_KTS; b += WIND_BARB_STEP_KTS) out.push(b)
  return out
}

/**
 * Speed-tiered barb colour: blue (light) → green (moderate) → amber
 * (strong), so intensity reads from colour alone, not just barb
 * notch-count/text. Single source of truth for both web (canvas draw,
 * apps/web/src/utils/windBarbIcons.ts) and native (baked into the
 * pre-rendered PNGs by apps/native/scripts/gen-wind-barb-icons.mjs, which
 * must be re-run if these thresholds/colours change since native can't
 * recolor at runtime).
 */
export function windBarbColorForSpeed(speedKts: number): string {
  if (speedKts < 10) return '#38bdf8' // light — sky blue
  if (speedKts < 25) return '#4ade80' // moderate — green
  return '#fbbf24' // strong — amber
}

/**
 * Shared stroke-width-by-speed rule for the plain directional wind arrows
 * used outside the barb overlay (Virtual Radar / Vertical Profile station
 * markers, web + native) — arrows get visibly thicker with wind strength,
 * not just longer, so strength reads at a glance there too, not just
 * from the numeric label
 * beside it.
 */
export function windArrowStrokeWidth(speedKt: number): number {
  return Math.min(4, 1.5 + speedKt / 12)
}

/** Feather breakdown for a raw speed -- pennant (50kt triangle), full barb
 * (10kt line), half barb (5kt line, at most one). Single source of truth
 * for the map's canvas/PNG barb icons AND the small Virtual Radar/Vertical
 * Profile chart barbs, so both read the same discrete feather count for a
 * given speed. */
export function windBarbFeathers(speedKts: number): { pennants: number; fulls: number; half: number } {
  const bucket = windBarbBucket(speedKts)
  let remaining = bucket
  const pennants = Math.floor(remaining / 50); remaining -= pennants * 50
  const fulls = Math.floor(remaining / 10); remaining -= fulls * 10
  const half = remaining >= 5 ? 1 : 0
  return { pennants, fulls, half }
}

export interface WindBarbLineSeg { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
export interface WindBarbTri { kind: 'tri'; points: [[number, number], [number, number], [number, number]] }
export type WindBarbShape = WindBarbLineSeg | WindBarbTri

/**
 * Barb geometry in a small, caller-scaled local space: shaft runs from
 * (0,0) (station point) to (0,-shaftLen) (tip, pointing "up" / north
 * before the caller's own dirDeg rotation), matching the same convention
 * already used by the map's drawWindBarb (web canvas) and
 * gen-wind-barb-icons.mjs (native PNGs) -- feathers nearest the tip are
 * the largest (pennants), then full barbs, then a single half barb
 * closest to the station. Returns feathers: [] for calm (bucket < 3) --
 * callers already draw a distinct calm-circle marker instead of a shaft.
 */
export function windBarbGeometry(
  speedKts: number,
  opts: { shaftLen?: number; barbLen?: number; halfLen?: number; barbGap?: number } = {},
): { shaft: WindBarbLineSeg | null; feathers: WindBarbShape[] } {
  const bucket = windBarbBucket(speedKts)
  const shaftLen = opts.shaftLen ?? 14
  const barbLen = opts.barbLen ?? 7
  const halfLen = opts.halfLen ?? 4
  const barbGap = opts.barbGap ?? 4
  const rad = Math.PI / 3 // barb angle off the shaft, matches map icon

  if (bucket < 3) return { shaft: null, feathers: [] }

  const tipY = -shaftLen
  const shaft: WindBarbLineSeg = { kind: 'line', x1: 0, y1: 0, x2: 0, y2: tipY }
  const { pennants, fulls, half } = windBarbFeathers(bucket)

  const feathers: WindBarbShape[] = []
  let y = tipY
  for (let i = 0; i < pennants; i++) {
    const y2 = y + barbGap
    feathers.push({
      kind: 'tri',
      points: [
        [0, y],
        [barbLen * Math.sin(rad), y + barbLen * Math.cos(rad) * 0.5],
        [0, y2],
      ],
    })
    y = y2
  }
  for (let i = 0; i < fulls; i++) {
    feathers.push({ kind: 'line', x1: 0, y1: y, x2: barbLen * Math.sin(rad), y2: y + barbLen * Math.cos(rad) })
    y += barbGap
  }
  if (half) {
    feathers.push({ kind: 'line', x1: 0, y1: y, x2: halfLen * Math.sin(rad), y2: y + halfLen * Math.cos(rad) })
  }

  return { shaft, feathers }
}
