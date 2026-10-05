/**
 * phoneVario — vertical speed from a phone's built-in barometer (~1 Hz,
 * irregular timing, noisier than a dedicated vario sensor). Wraps
 * BaroKalmanFilter with phone-appropriate tuning and per-sample timing.
 *
 * The filter is always fed against the ISA datum (1013.25 hPa), never the
 * pilot's QNH: vertical speed is a derivative, so a QNH change (new METAR,
 * manual edit) must not appear as a step in altitude and a VS spike.
 */

import { BaroKalmanFilter } from './baroKalman'

const FT_MIN_PER_MS = 196.850394
const ISA_QNH_HPA = 1013.25
// Phone sensors are noisier than the dedicated vario's, and sampled ~50x
// slower, so trust each altitude sample less and let velocity move faster.
const PHONE_POSITION_NOISE = 1.0
const PHONE_ACCEL_NOISE = 0.15
/** Samples further apart than this restart the filter (app resumed, sensor paused). */
const MAX_GAP_MS = 5_000
/** Output is withheld for this many samples after (re)start while the estimate settles. */
const WARMUP_SAMPLES = 5
/** Below this magnitude, show 0 so a level phone doesn't flicker +/-few fpm. */
const DEADBAND_FT_MIN = 20

export class PhoneVarioFilter {
  private readonly filter = new BaroKalmanFilter({
    positionNoiseVariance: PHONE_POSITION_NOISE,
    accelNoiseVariance:    PHONE_ACCEL_NOISE,
  })
  private lastMs: number | null = null
  private count = 0

  /** Feed one pressure sample (hPa) with its wall-clock time (ms).
   *  Returns vertical speed in ft/min, or null while warming up. */
  update(pressureHpa: number, nowMs: number): number | null {
    if (!Number.isFinite(pressureHpa) || pressureHpa <= 0) return null
    if (this.lastMs != null && (nowMs - this.lastMs > MAX_GAP_MS || nowMs <= this.lastMs)) {
      if (nowMs <= this.lastMs) return null  // duplicate / out-of-order timestamp: ignore
      this.reset()
    }
    const dtSec = this.lastMs == null ? undefined : (nowMs - this.lastMs) / 1000
    this.lastMs = nowMs
    const est = this.filter.update(pressureHpa * 100, ISA_QNH_HPA, dtSec)
    this.count++
    if (this.count < WARMUP_SAMPLES) return null
    const vs = est.verticalMs * FT_MIN_PER_MS
    return Math.abs(vs) < DEADBAND_FT_MIN ? 0 : vs
  }

  reset(): void {
    this.filter.reset()
    this.lastMs = null
    this.count = 0
  }
}
