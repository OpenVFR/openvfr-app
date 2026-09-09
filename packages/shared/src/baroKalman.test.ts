import { describe, it, expect } from 'vitest'
import { BaroKalmanFilter } from './baroKalman'
import { pressureToAltitudeM } from './baroAltitude'

const QNH = 1013.25

/** Pressure (Pa) that corresponds to a given ISA altitude (m) at the given QNH \u2014
 *  inverse of the ISA formula in baroAltitude.ts, used to build synthetic samples. */
function pressureForAltitudeM(altM: number, qnhHpa = QNH): number {
  const qnhPa = qnhHpa * 100
  return qnhPa * Math.pow(1 - altM / 44301.59796, 1 / 0.190295)
}

describe('BaroKalmanFilter', () => {
  it('seeds altitude directly from the first sample, velocity = 0', () => {
    const filter = new BaroKalmanFilter()
    const pa = pressureForAltitudeM(500)
    const result = filter.update(pa, QNH)
    expect(result.altitudeM).toBeCloseTo(pressureToAltitudeM(pa, QNH), 6)
    expect(result.verticalMs).toBe(0)
  })

  it('converges toward a steady climb rate given a constant-rate pressure ramp', () => {
    const filter = new BaroKalmanFilter({ dt: 0.02 })
    const climbRateMs = 2.5  // steady 2.5 m/s climb
    let altM = 0
    let last = filter.update(pressureForAltitudeM(altM), QNH)
    // Feed 1000 samples (20s) of a perfectly steady climb \u2014 filter should
    // converge close to the true rate well within that window.
    for (let i = 0; i < 1000; i++) {
      altM += climbRateMs * 0.02
      last = filter.update(pressureForAltitudeM(altM), QNH)
    }
    expect(Math.abs(last.verticalMs - climbRateMs)).toBeLessThan(0.3)
  })

  it('smooths out noisy instantaneous samples around a level altitude (near-zero VS)', () => {
    const filter = new BaroKalmanFilter()
    const baseAlt = 300
    // Deterministic pseudo-noise (no RNG dependency) oscillating +/-3m around
    // a level altitude \u2014 emulates raw sensor jitter while physically level.
    let last = filter.update(pressureForAltitudeM(baseAlt), QNH)
    for (let i = 1; i <= 500; i++) {
      const noise = Math.sin(i * 1.7) * 3
      last = filter.update(pressureForAltitudeM(baseAlt + noise), QNH)
    }
    // A raw per-sample derivative of this noise would swing wildly
    // (multiple m/s); the filtered estimate should stay much calmer.
    expect(Math.abs(last.verticalMs)).toBeLessThan(1.5)
  })

  it('reset() clears state so the next sample reseeds instead of blending', () => {
    const filter = new BaroKalmanFilter()
    filter.update(pressureForAltitudeM(1000), QNH)
    filter.update(pressureForAltitudeM(1010), QNH)
    filter.reset()
    const pa = pressureForAltitudeM(50)
    const result = filter.update(pa, QNH)
    expect(result.altitudeM).toBeCloseTo(pressureToAltitudeM(pa, QNH), 6)
    expect(result.verticalMs).toBe(0)
  })

  it('applies QNH correction consistently with pressureToAltitudeM', () => {
    const filter = new BaroKalmanFilter()
    const pa = pressureForAltitudeM(1000, 1000)  // built against QNH=1000
    const result = filter.update(pa, 1000)
    expect(result.altitudeM).toBeCloseTo(1000, 3)
  })
})
