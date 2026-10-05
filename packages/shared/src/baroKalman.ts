/**
 * baroKalman — 2-state (altitude, vertical velocity) Kalman filter for raw
 * barometric pressure sensor streams, used instead of trusting a vario's
 * onboard "vario_cms"/"vario" telemetry field directly.
 *
 * Rationale (see conversation in native/ble-pressure.md context): some
 * firmwares report a "filtered" pressure field but an unfiltered/noisy
 * derivative for climb rate. Rather than depend on that, run our own
 * constant-velocity Kalman filter directly on raw pressure samples at the
 * sensor's native rate (BlueFly Vario raw mode = 50 Hz, dt = 0.02 s),
 * converting each fused altitude estimate to metres via the ISA formula.
 *
 * Model: x = [altitude_m, verticalVelocity_m/s], constant-velocity process
 * model with acceleration-variance process noise, position-only measurement
 * update (we only ever measure altitude, never velocity directly).
 */

import { pressureToAltitudeM } from './baroAltitude'

export type BaroKalmanEstimate = {
  altitudeM:     number
  verticalMs:    number
}

export type BaroKalmanOptions = {
  /** Fixed sample interval in seconds (BlueFly raw mode: 50 Hz -> 0.02). */
  dt?: number
  /** Measurement noise variance (m^2) for the altitude derived from a single
   *  raw pressure sample. ~0.2 per the reference implementation. */
  positionNoiseVariance?: number
  /** Process noise: variance of vertical acceleration (m/s^2)^2, driving
   *  how quickly the filter's velocity estimate can change. Tunable — too
   *  low and it lags real climb-rate changes, too high and it stays noisy. */
  accelNoiseVariance?: number
}

const DEFAULT_DT = 0.02
const DEFAULT_POSITION_NOISE = 0.2
// Lower = smoother/more damped, higher = snappier but noisier. 0.1 still let
// stationary readings jitter several hundred ft/min after switching to raw
// pressure + our own filter; 0.02 holds near-zero much closer to BlueFly's
// own app (~constant, single-digit ft/min) while still tracking a real
// climb/sink within a second or two.
const DEFAULT_ACCEL_NOISE = 0.02

/** Small fixed-size 2x2 matrix helpers — avoids pulling in a matrix library
 *  for what's a tiny, fixed-dimension filter. */
type Mat2 = [[number, number], [number, number]]

export class BaroKalmanFilter {
  private readonly dt: number
  private readonly R: number
  private readonly q: number

  private x: [number, number] | null = null  // [altitude_m, velocity_m/s]
  private P: Mat2 = [[1, 0], [0, 1]]

  constructor(options: BaroKalmanOptions = {}) {
    this.dt = options.dt ?? DEFAULT_DT
    this.R  = options.positionNoiseVariance ?? DEFAULT_POSITION_NOISE

    this.q = options.accelNoiseVariance ?? DEFAULT_ACCEL_NOISE
  }

  /** Discretized constant-velocity process noise (standard Kalman-filter
   *  textbook form for a "white noise acceleration" model) for a given dt. */
  private processNoise(dt: number): Mat2 {
    const q = this.q
    return [
      [q * (dt ** 4) / 4, q * (dt ** 3) / 2],
      [q * (dt ** 3) / 2, q * (dt ** 2)],
    ]
  }

  /** Feed one raw pressure sample (Pa) + the QNH (hPa) currently in effect,
   *  return the fused altitude/vertical-speed estimate. First call seeds the
   *  filter state directly from the measurement (velocity = 0).
   *  `dtSec` overrides the constructor's fixed interval for this step — for
   *  sensors with an irregular sample rate (e.g. a phone barometer). */
  update(pressurePa: number, qnhHpa: number, dtSec?: number): BaroKalmanEstimate {
    const measuredAltM = pressureToAltitudeM(pressurePa, qnhHpa)

    if (!this.x) {
      this.x = [measuredAltM, 0]
      return { altitudeM: measuredAltM, verticalMs: 0 }
    }

    const dt = dtSec ?? this.dt
    const Q  = this.processNoise(dt)
    const [altPrev, velPrev] = this.x
    const P = this.P

    // ── Predict ──────────────────────────────────────────────────────────
    const altPred = altPrev + velPrev * dt
    const velPred = velPrev

    // P_pred = F P F^T + Q, with F = [[1, dt], [0, 1]]
    const p00 = P[0][0] + dt * (P[1][0] + P[0][1] + dt * P[1][1])
    const p01 = P[0][1] + dt * P[1][1]
    const p10 = P[1][0] + dt * P[1][1]
    const p11 = P[1][1]

    const P00 = p00 + Q[0][0]
    const P01 = p01 + Q[0][1]
    const P10 = p10 + Q[1][0]
    const P11 = p11 + Q[1][1]

    // ── Update (measurement = altitude only, H = [1, 0]) ────────────────
    const y = measuredAltM - altPred
    const S = P00 + this.R
    const K0 = P00 / S
    const K1 = P10 / S

    const altNew = altPred + K0 * y
    const velNew = velPred + K1 * y

    this.x = [altNew, velNew]
    this.P = [
      [P00 - K0 * P00, P01 - K0 * P01],
      [P10 - K1 * P00, P11 - K1 * P01],
    ]

    return { altitudeM: altNew, verticalMs: velNew }
  }

  reset(): void {
    this.x = null
    this.P = [[1, 0], [0, 1]]
  }
}
