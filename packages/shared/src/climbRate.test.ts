import { describe, it, expect } from 'vitest'
import { updateClimbRate, type ClimbState } from './climbRate'

const run = (alts: number[], stepMs = 1000) => {
  let s: ClimbState | null = null
  alts.forEach((a, i) => { s = updateClimbRate(s, a, i * stepMs) })
  return s as unknown as ClimbState
}

describe('updateClimbRate', () => {
  it('converges to a steady descent', () => {
    // -10 ft per second = -600 fpm
    const s = run(Array.from({ length: 40 }, (_, i) => 3000 - i * 10))
    expect(s.rateFpm).toBeLessThan(-550)
    expect(s.rateFpm).toBeGreaterThan(-650)
  })
  it('stays small for GPS jitter in level flight', () => {
    const s = run(Array.from({ length: 40 }, (_, i) => 3000 + (i % 2 ? 10 : -10)))
    expect(Math.abs(s.rateFpm)).toBeLessThan(250)
  })
  it('starts at zero and restarts after a long gap', () => {
    expect(updateClimbRate(null, 1000, 0).rateFpm).toBe(0)
    const s = updateClimbRate({ altFt: 1000, ts: 0, rateFpm: -800 }, 500, 60_000)
    expect(s.rateFpm).toBe(0)
  })
})
