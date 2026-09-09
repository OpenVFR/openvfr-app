/**
 * windRelative — decomposes a WindAloft reading into head/tailwind and
 * crosswind components relative to the aircraft's current ground track,
 * plus a crosswind-severity colour tier and an arrow rotation for a
 * "which way is the wind pushing me" gauge indicator.
 *
 * Shared between web (GoFlyingPanel.tsx) and native (GaugesBar.tsx) so the
 * math and severity thresholds can't drift apart between the two — see
 * AGENTS.md's "never hardcode a copy of a shared colour palette" rule;
 * this extends the same principle to the derived category, not just the
 * colour itself.
 *
 * Design note — why colour is crosswind-only, not headwind/tailwind:
 * headwind vs. tailwind isn't inherently "good" or "bad" — it depends on
 * flight phase. A tailwind is a bonus enroute (higher groundspeed) but
 * dangerous on takeoff/landing (longer roll, less margin) — the opposite
 * of headwind. Since this is a single in-flight gauge with no notion of
 * "am I on approach right now", colouring headwind red / tailwind green
 * would be actively misleading exactly when it matters most (on final).
 * Crosswind, by contrast, is unfavourable in every phase of flight, so its
 * magnitude is the only safe thing to colour-code here. The arrow's
 * rotation still conveys the with/against-you sense (up = wind blowing
 * toward your nose direction = tailwind pushing you forward; down =
 * headwind opposing you) — direction is shown, but not judged by colour.
 *
 * Convention (matches GoFlyingPanel.tsx's pre-existing math):
 *   hw > 0  → headwind (slows groundspeed)
 *   hw < 0  → tailwind (speeds groundspeed)
 *   xw > 0  → crosswind from the right (starboard)
 *   xw < 0  → crosswind from the left (port)
 */

import type { WindAloft } from './fetchWind'

export type CrosswindSeverity = 'calm' | 'moderate' | 'strong'

/** Crosswind magnitude thresholds, knots — rough light-aircraft demonstrated-crosswind-limit bands. */
const CROSSWIND_MODERATE_KTS = 8
const CROSSWIND_STRONG_KTS   = 15

export interface WindRelative {
  /** Headwind component, knots. Positive = headwind, negative = tailwind. */
  hw: number
  /** Crosswind component magnitude, knots (always ≥ 0). */
  xw: number
  /** Crosswind is from the right (starboard) side. */
  xwRight: boolean
  /** Crosswind severity tier — the only component this module colour-codes. */
  crosswindSeverity: CrosswindSeverity
  /**
   * Degrees to rotate an "arrow" icon so it points in the direction the wind
   * is blowing TOWARD, relative to the aircraft's nose (0° = straight ahead
   * = tailwind pushing you forward; 180° = straight down/behind = headwind
   * opposing you; ±90° = pure crosswind from the side). Direction only —
   * deliberately not tied to a colour (see module doc comment above).
   */
  arrowRotationDeg: number
}

/**
 * Returns null if wind is unknown, or if groundspeed is too low for a
 * track-relative decomposition to be meaningful (mirrors GoFlyingPanel's
 * existing `pos.speedKts > 5` guard — below that, GPS track is unreliable).
 */
export function computeWindRelative(
  wind: WindAloft | null | undefined,
  trackDeg: number,
  speedKts: number,
): WindRelative | null {
  if (!wind || speedKts <= 5) return null

  const angleRad = (wind.dirDeg - trackDeg) * Math.PI / 180
  const hw = wind.speedKts * Math.cos(angleRad)
  const xw = wind.speedKts * Math.sin(angleRad)
  const xwAbs = Math.abs(xw)

  const crosswindSeverity: CrosswindSeverity =
    xwAbs >= CROSSWIND_STRONG_KTS   ? 'strong' :
    xwAbs >= CROSSWIND_MODERATE_KTS ? 'moderate' :
    'calm'

  // "Blowing toward" bearing (reciprocal of the "from" direction), relative
  // to the aircraft's nose (track). 0° = dead ahead = pure tailwind.
  const arrowRotationDeg = ((wind.dirDeg + 180 - trackDeg) % 360 + 360) % 360

  return {
    hw: Math.round(hw),
    xw: Math.round(xwAbs),
    xwRight: xw >= 0,
    crosswindSeverity,
    arrowRotationDeg,
  }
}
