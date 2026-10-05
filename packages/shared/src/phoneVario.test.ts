import { describe, it, expect } from 'vitest'
import { PhoneVarioFilter } from './phoneVario'

function hpaForAltitudeM(altM: number): number {
  return 1013.25 * Math.pow(1 - altM / 44301.59796, 1 / 0.190295)
}
// Deterministic jitter, roughly +/-0.08 hPa (~0.7 m) like a phone sensor.
const noise = (i: number) => Math.sin(i * 12.9898) * 0.08

describe('PhoneVarioFilter', () => {
  it('withholds output during warm-up', () => {
    const f = new PhoneVarioFilter()
    expect(f.update(hpaForAltitudeM(100), 0)).toBeNull()
    expect(f.update(hpaForAltitudeM(100), 1000)).toBeNull()
  })

  it('reads ~0 when level despite sensor noise', () => {
    const f = new PhoneVarioFilter()
    let last: number | null = null
    for (let i = 0; i < 60; i++) last = f.update(hpaForAltitudeM(300) + noise(i), i * 1000)
    expect(Math.abs(last!)).toBeLessThan(100)
  })

  it('tracks a 500 ft/min climb within ~15 s, with noise', () => {
    const f = new PhoneVarioFilter()
    const climbMs = 500 / 196.850394
    let last: number | null = null
    for (let i = 0; i < 20; i++) last = f.update(hpaForAltitudeM(300 + climbMs * i) + noise(i), i * 1000)
    expect(last!).toBeGreaterThan(350)
    expect(last!).toBeLessThan(650)
  })

  it('tracks a descent with the right sign', () => {
    const f = new PhoneVarioFilter()
    const sinkMs = -500 / 196.850394
    let last: number | null = null
    for (let i = 0; i < 20; i++) last = f.update(hpaForAltitudeM(1000 + sinkMs * i) + noise(i), i * 1000)
    expect(last!).toBeLessThan(-350)
  })

  it('handles irregular sample spacing', () => {
    const f = new PhoneVarioFilter()
    const climbMs = 500 / 196.850394
    let t = 0
    let last: number | null = null
    for (let i = 0; i < 25; i++) {
      t += i % 2 === 0 ? 700 : 1300
      last = f.update(hpaForAltitudeM(300 + climbMs * (t / 1000)), t)
    }
    expect(Math.abs(last! - 500)).toBeLessThan(120)
  })

  it('restarts after a long gap instead of producing a spike', () => {
    const f = new PhoneVarioFilter()
    for (let i = 0; i < 20; i++) f.update(hpaForAltitudeM(300), i * 1000)
    // 10 min later at a very different altitude (e.g. app was backgrounded)
    expect(f.update(hpaForAltitudeM(1800), 600_000)).toBeNull()
  })
})
