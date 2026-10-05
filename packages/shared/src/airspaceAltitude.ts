/**
 * airspaceAltitude — pick the right own-ship altitude for an airspace limit.
 *
 * ICAO Annex 2 / SERA.5015 + Annex 11: limits are published in the reference
 * that applies at that level —
 *   "FL065"        → flight level, pressure altitude on 1013.25 hPa
 *   "1500ft MSL"   → altitude, ft AMSL on QNH
 *   "GND"/"SFC"/"1500ft AGL" → height above the terrain under the aircraft;
 *                    compared on QNH altitude after adding the local ground
 *                    elevation (see effectiveLimitFt)
 * GPS altitude is geometric and is not the legal reference in either case;
 * it is only the fallback when no barometric source exists.
 */

/** True when the limit string is a flight level (1013.25 hPa reference). */
export function limitIsFlightLevel(limit: string | null | undefined): boolean {
  return typeof limit === 'string' && /^\s*FL\s*\d+/i.test(limit)
}

/** True when the limit is a height above ground (AGL / GND / SFC), not an altitude. */
export function limitIsAgl(limit: string | null | undefined): boolean {
  return typeof limit === 'string' && /\b(AGL|GND|SFC|SURFACE)\b/i.test(limit)
}

/**
 * Limit as an altitude (ft) comparable with own QNH/pressure altitude.
 * `limitFt` is the numeric value stored with the airspace feature (for AGL
 * limits this is the height above ground, for all others an altitude). AGL
 * limits are lifted by `terrainFt` (ground elevation under the aircraft,
 * ft AMSL); when terrain is unknown the raw value is used, which is the
 * pre-existing behaviour and errs on the early side for floors.
 */
export function effectiveLimitFt(
  limit: string | null | undefined,
  limitFt: number,
  terrainFt: number | null | undefined,
): number {
  if (terrainFt != null && Number.isFinite(terrainFt) && limitIsAgl(limit)) return limitFt + Math.max(0, terrainFt)
  return limitFt
}

export type OwnAltitudes = {
  /** Altitude on QNH (or GPS fallback when no baro). */
  qnhFt: number
  /** Pressure altitude on 1013.25 hPa; null when no barometric source. */
  stdFt: number | null
  /** True when qnhFt rests on an unverified QNH (stored/default value). */
  qnhUncertain?: boolean
}

/** Own-ship altitude to compare against one published limit. */
export function altitudeForLimit(limit: string | null | undefined, alt: OwnAltitudes): number {
  return limitIsFlightLevel(limit) && alt.stdFt != null ? alt.stdFt : alt.qnhFt
}

/**
 * Extra vertical buffer (ft) to apply when the own altitude used for a limit
 * is not in that limit's reference: an FL limit evaluated on QNH/GPS altitude
 * (no pressure altitude available), or any limit evaluated on an unverified
 * QNH. ~500 ft corresponds to ~18 hPa of QNH error.
 */
export const ALT_REF_UNCERTAIN_MARGIN_FT = 500

/** Buffer to widen floor/ceiling-closure warnings by for this limit. */
export function limitMarginFt(limit: string | null | undefined, alt: OwnAltitudes): number {
  if (alt.qnhUncertain) return ALT_REF_UNCERTAIN_MARGIN_FT
  if (limitIsFlightLevel(limit) && alt.stdFt == null) return ALT_REF_UNCERTAIN_MARGIN_FT
  return 0
}

/**
 * Vertical hysteresis for "inside airspace" state. An aircraft hovering at a
 * floor/ceiling must not flap between entered/left every tick: once inside,
 * it stays inside until it is this far outside the band.
 */
export const INSIDE_HYSTERESIS_FT = 100

export function insideBand(
  altLo: number, altHi: number, lowerFt: number, upperFt: number, wasInside: boolean,
): boolean {
  const h = wasInside ? INSIDE_HYSTERESIS_FT : 0
  return altLo >= lowerFt - h && altHi <= upperFt + h
}
