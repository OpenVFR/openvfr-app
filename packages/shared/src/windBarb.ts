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
 * Speed-tiered barb colour — SkyDemon's "wind feather" convention (see
 * skydemon.md's Winds Aloft section): blue (light) → green (moderate) →
 * amber (strong), so intensity reads from colour alone, not just barb
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
 * markers, web + native) — SkyDemon's virtual radar wind arrows get
 * visibly thicker with wind strength, not just longer; this mirrors that
 * so strength reads at a glance there too, not just from the numeric label
 * beside it.
 */
export function windArrowStrokeWidth(speedKt: number): number {
  return Math.min(4, 1.5 + speedKt / 12)
}
