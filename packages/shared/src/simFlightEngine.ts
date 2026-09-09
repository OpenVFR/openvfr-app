/**
 * SimFlightEngine — pure tick-based aircraft physics for internal
 * (no-hardware, no-external-simulator) flight simulation.
 *
 * Ported from web's useGoFlying.ts sim-mode tick loop, decoupled from its
 * keyboard-specific input handling so both web (keyboard) and native
 * (touch buttons) can drive the same physics with different input methods.
 *
 * Framework/platform agnostic — only depends on setInterval/clearInterval
 * (universal) and routeCalc's pure math. No DOM, no React.
 *
 * ── Control model ──────────────────────────────────────────────────────────
 * HDG/SPEED/ALT use discrete steps (adjustHeading/adjustSpeed/adjustAlt),
 * not a continuous per-tick ramp. An earlier revision ramped these
 * continuously while a button was held (SimControl.throttle/.climb,
 * consumed every 5 Hz tick) — that caused two problems:
 *   1. A quick tap produced an invisible sub-1-unit change (2 kts/s * one
 *      200ms tick = 0.4 kt, rounds away), so short presses looked like they
 *      did nothing.
 *   2. Holding the button meant setPosition() (React state) fired at the
 *      full 5 Hz tick rate for as long as the finger stayed down, which
 *      could cascade into consumers with their own setState-on-position
 *      effects (e.g. the look-ahead route-synthesis effect in MapScreen)
 *      faster than their own guard conditions could settle, occasionally
 *      tripping React's "Maximum update depth exceeded" safety limit.
 * The UI layer (SimControlPanel's useHoldRepeat) now implements the
 * hold-to-repeat-faster behaviour itself, calling adjustX() repeatedly at an
 * accelerating JS-timer interval — each call is a single, complete,
 * immediately-visible step and a single emit(), decoupled from the engine's
 * own 5 Hz position tick.
 *
 * Target-steering (setTarget/clearTarget) still uses continuous per-tick
 * turning — that one is fine because it terminates itself on arrival rather
 * than being held down by a finger for an indefinite duration.
 */

import { bearingDeg, distanceNm, advancePosition } from './routeCalc'
import type { GpsPosition } from './gpsTypes'

const TICK_MS  = 200        // 5 Hz — position advance + target-steering only
const TICK_S   = TICK_MS / 1000
const TURN_DEG_S  = 3       // turn rate °/s — target-steering only
const MAX_SPEED_KTS = 300
const MAX_ALT_FT     = 50000
const TARGET_ARRIVE_NM = 0.1

/** Discrete step sizes for the touch stepper buttons (HDG/SPEED/ALT). */
export const SPEED_STEP_KTS = 5
export const ALT_STEP_FT    = 50
export const HDG_STEP_DEG   = 5

type State = {
  lat: number
  lng: number
  altFt: number
  speedKts: number
  trackDeg: number
  targetLat: number | null
  targetLng: number | null
}

export class SimFlightEngine {
  private state: State | null = null
  private intervalId: ReturnType<typeof setInterval> | null = null
  private onUpdate: (pos: GpsPosition) => void
  private onTargetChange?: (hasTarget: boolean) => void

  constructor(onUpdate: (pos: GpsPosition) => void, onTargetChange?: (hasTarget: boolean) => void) {
    this.onUpdate = onUpdate
    this.onTargetChange = onTargetChange
  }

  isRunning(): boolean {
    return this.state !== null
  }

  start(initialPos: { lat: number; lng: number }, initialSpeedKts = 90, initialTrackDeg = 0, initialAltFt = 1000): void {
    this.stop()
    this.state = {
      lat: initialPos.lat,
      lng: initialPos.lng,
      altFt: initialAltFt,
      speedKts: initialSpeedKts,
      trackDeg: initialTrackDeg,
      targetLat: null,
      targetLng: null,
    }
    // Do NOT call this.emit() here — that fires setPosition() synchronously
    // from within engine.start() → simFlight.start() → handleStartSim (a
    // React event handler). The synchronous setState cascade triggers the
    // look-ahead useEffect which itself calls setState, exhausting React's
    // update-depth limit. The first tick (TICK_MS ms) will emit the initial
    // position via the normal async setInterval path instead.
    this.intervalId = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.state = null
  }

  /** Immediate discrete heading step (±HDG_STEP_DEG) — primary HDG control. */
  adjustHeading(dir: -1 | 1): void {
    const s = this.state
    if (!s) return
    s.trackDeg = (s.trackDeg + dir * HDG_STEP_DEG + 360) % 360
    this.emit()
  }

  /** Immediate discrete speed step (±SPEED_STEP_KTS) — primary SPEED control. */
  adjustSpeed(dir: -1 | 1): void {
    const s = this.state
    if (!s) return
    s.speedKts = Math.max(0, Math.min(MAX_SPEED_KTS, s.speedKts + dir * SPEED_STEP_KTS))
    this.emit()
  }

  /** Immediate discrete altitude step (±ALT_STEP_FT) — primary ALT control. */
  adjustAlt(dir: -1 | 1): void {
    const s = this.state
    if (!s) return
    s.altFt = Math.max(0, Math.min(MAX_ALT_FT, s.altFt + dir * ALT_STEP_FT))
    this.emit()
  }

  /** Click/tap-to-navigate: steer toward a point, overrides manual turn
   *  control until arrival (within TARGET_ARRIVE_NM) or cleared. */
  setTarget(lat: number, lng: number): void {
    if (!this.state) return
    this.state.targetLat = lat
    this.state.targetLng = lng
    this.onTargetChange?.(true)
  }

  clearTarget(): void {
    if (!this.state) return
    this.state.targetLat = null
    this.state.targetLng = null
    this.onTargetChange?.(false)
  }

  /** Drag-to-reposition — instantly moves the aircraft, no physics involved. */
  teleport(lat: number, lng: number): void {
    if (!this.state) return
    this.state.lat = lat
    this.state.lng = lng
    this.emit()
  }

  /** Advance immediately by `nm` along the current track (web's 'Q' key). */
  advanceNm(nm: number): void {
    if (!this.state) return
    const { lat, lng } = advancePosition(this.state.lat, this.state.lng, this.state.trackDeg, nm)
    this.state.lat = lat
    this.state.lng = lng
    this.emit()
  }

  private tick(): void {
    const s = this.state
    if (!s) return

    // ── Target steering (continuous — terminates itself on arrival) ──────
    if (s.targetLat !== null && s.targetLng !== null) {
      const distToTarget = distanceNm(s, { lat: s.targetLat, lng: s.targetLng })
      if (distToTarget < TARGET_ARRIVE_NM) {
        s.targetLat = null
        s.targetLng = null
        this.onTargetChange?.(false)
      } else {
        const targetBrg = bearingDeg(s, { lat: s.targetLat, lng: s.targetLng })
        const diff    = ((targetBrg - s.trackDeg + 540) % 360) - 180  // −180..+180
        const maxTurn = TURN_DEG_S * TICK_S
        s.trackDeg = (s.trackDeg + Math.max(-maxTurn, Math.min(maxTurn, diff)) + 360) % 360
      }
    }

    // ── Advance position ───────────────────────────────────────────────────
    const distNm = s.speedKts * TICK_S / 3600
    if (distNm > 0) {
      const { lat, lng } = advancePosition(s.lat, s.lng, s.trackDeg, distNm)
      s.lat = lat
      s.lng = lng
    }

    this.emit()
  }

  private emit(): void {
    const s = this.state
    if (!s) return
    this.onUpdate({
      lat: s.lat,
      lng: s.lng,
      altFt: s.altFt,
      speedKts: s.speedKts,
      trackDeg: s.trackDeg,
      accuracy: 0,
    })
  }
}
