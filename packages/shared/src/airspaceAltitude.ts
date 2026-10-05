/**
 * airspaceAltitude — pick the right own-ship altitude for an airspace limit.
 *
 * ICAO Annex 2 / SERA.5015 + Annex 11: limits are published in the reference
 * that applies at that level —
 *   "FL065"        → flight level, pressure altitude on 1013.25 hPa
 *   "1500ft MSL"   → altitude, ft AMSL on QNH
 *   "GND"/"SFC"/AGL → handled by the caller as before (QNH altitude used)
 * GPS altitude is geometric and is not the legal reference in either case;
 * it is only the fallback when no barometric source exists.
 */

/** True when the limit string is a flight level (1013.25 hPa reference). */
export function limitIsFlightLevel(limit: string | null | undefined): boolean {
  return typeof limit === 'string' && /^\s*FL\s*\d+/i.test(limit)
}

export type OwnAltitudes = {
  /** Altitude on QNH (or GPS fallback when no baro). */
  qnhFt: number
  /** Pressure altitude on 1013.25 hPa; null when no barometric source. */
  stdFt: number | null
}

/** Own-ship altitude to compare against one published limit. */
export function altitudeForLimit(limit: string | null | undefined, alt: OwnAltitudes): number {
  return limitIsFlightLevel(limit) && alt.stdFt != null ? alt.stdFt : alt.qnhFt
}
