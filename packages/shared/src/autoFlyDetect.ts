/**
 * Auto flying-mode detection, shared by web and native.
 *
 * A pure state machine fed one GPS fix at a time. It never starts or stops
 * anything itself; it emits a suggestion event and the host app decides
 * (prompt the pilot, or act directly when the setting is 'auto').
 *
 *  - Not flying: ground speed >= AIRBORNE_SPD_KTS for AIRBORNE_CONFIRM_FIXES
 *    consecutive accurate fixes -> 'suggest-start'. Fires once; re-arms only
 *    after speed drops below LANDED_SPD_KTS (a car on a motorway or a train
 *    gives one dismissable suggestion, not a nag).
 *  - Flying: after the aircraft was seen at >= TAKEOFF_SPD_KTS and at least
 *    MIN_AIRBORNE_MS have passed, ground speed < LANDED_SPD_KTS for
 *    LANDED_CONFIRM_FIXES consecutive fixes -> 'suggest-stop'.
 *
 * The three speeds scale with the aircraft's takeoff speed (aircraft profile,
 * else a per-category default) via autoFlyThresholds(); the exported constants
 * are the values for the 30 kt default.
 */

export type AutoFlyMode = 'off' | 'ask' | 'auto'
export const AUTO_FLY_MODES: readonly AutoFlyMode[] = ['off', 'ask', 'auto']
export const AUTO_FLY_DEFAULT: AutoFlyMode = 'ask'

export const AIRBORNE_SPD_KTS      = 40
export const AIRBORNE_CONFIRM_FIXES = 5
export const TAKEOFF_SPD_KTS       = 30
export const LANDED_SPD_KTS        = 20
export const LANDED_CONFIRM_FIXES  = 10
export const MIN_AIRBORNE_MS       = 60_000
/** Fixes less accurate than this are ignored for start detection. */
export const MAX_ACCURACY_M        = 100

/** Speed thresholds (kt) for one aircraft. */
export interface AutoFlyThresholds {
  /** Not flying: this fast for AIRBORNE_CONFIRM_FIXES fixes suggests a start. */
  airborneKts: number
  /** Flying: reaching this marks the aircraft as having taken off. */
  takeoffKts: number
  /** Below this the aircraft counts as landed / stopped (also re-arms a start). */
  landedKts: number
}

/** Takeoff speed (kt) when the profile has none. Speed-based detection is only approximate for helicopters. */
export const DEFAULT_TAKEOFF_SPD_KTS: Readonly<Record<string, number>> = {
  SEP: 30, MEP: 40, TMG: 30, MICRO: 25, GYRO: 20, HELI: 20, GLIDER: 35,
}
const FALLBACK_TAKEOFF_SPD_KTS = 30

/** Thresholds for a takeoff speed (kt, 0/undefined = category default). At 30 kt: start 40, takeoff 30, landed 20. */
export function autoFlyThresholds(takeoffSpeedKts?: number | null, category?: string): AutoFlyThresholds {
  const v = takeoffSpeedKts && takeoffSpeedKts > 0
    ? takeoffSpeedKts
    : (category ? DEFAULT_TAKEOFF_SPD_KTS[category] : undefined) ?? FALLBACK_TAKEOFF_SPD_KTS
  return {
    airborneKts: Math.round(v + 10),
    takeoffKts:  Math.round(v),
    landedKts:   Math.max(10, Math.round(v * 2 / 3)),
  }
}

export const DEFAULT_AUTO_FLY_THRESHOLDS: AutoFlyThresholds = autoFlyThresholds()

export interface AutoFlyFix {
  speedKts: number
  /** Horizontal accuracy in metres; 0/unknown is treated as acceptable. */
  accuracyM: number
  /** Epoch ms. */
  t: number
}

export interface AutoFlyState {
  fastFixes: number
  slowFixes: number
  airborneSince: number | null
  /** Start suggestion already emitted (or user stopped mid-air); waits for a slow fix. */
  suppressed: boolean
  wasFlying: boolean
}

export type AutoFlyEvent = 'suggest-start' | 'suggest-stop' | null

export function initialAutoFlyState(): AutoFlyState {
  return { fastFixes: 0, slowFixes: 0, airborneSince: null, suppressed: false, wasFlying: false }
}

export function stepAutoFly(
  prev: AutoFlyState,
  fix: AutoFlyFix,
  flying: boolean,
  thr: AutoFlyThresholds = DEFAULT_AUTO_FLY_THRESHOLDS,
): { state: AutoFlyState; event: AutoFlyEvent } {
  const s: AutoFlyState = { ...prev }
  let event: AutoFlyEvent = null

  // Mode transitions: entering flight clears start tracking; leaving it while
  // still fast must not immediately re-suggest a start.
  if (flying && !s.wasFlying) {
    s.fastFixes = 0; s.slowFixes = 0; s.airborneSince = null
  }
  if (!flying && s.wasFlying) {
    s.fastFixes = 0; s.slowFixes = 0; s.airborneSince = null; s.suppressed = true
  }
  s.wasFlying = flying

  if (!Number.isFinite(fix.speedKts)) return { state: s, event }

  if (!flying) {
    const accurate = !(fix.accuracyM > MAX_ACCURACY_M)
    if (fix.speedKts < thr.landedKts) {
      s.fastFixes = 0; s.suppressed = false
    } else if (fix.speedKts >= thr.airborneKts && accurate) {
      s.fastFixes += 1
      if (s.fastFixes >= AIRBORNE_CONFIRM_FIXES && !s.suppressed) {
        s.suppressed = true
        event = 'suggest-start'
      }
    } else {
      s.fastFixes = 0
    }
    return { state: s, event }
  }

  if (s.airborneSince === null) {
    if (fix.speedKts >= thr.takeoffKts) s.airborneSince = fix.t
    return { state: s, event }
  }
  if (fix.speedKts < thr.landedKts && fix.t - s.airborneSince >= MIN_AIRBORNE_MS) {
    s.slowFixes += 1
    if (s.slowFixes >= LANDED_CONFIRM_FIXES) {
      s.slowFixes = 0
      s.airborneSince = null
      event = 'suggest-stop'
    }
  } else {
    s.slowFixes = 0
  }
  return { state: s, event }
}
