import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SimFlightEngine } from './simFlightEngine'

describe('SimFlightEngine emit rate', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('emits about once a second although the physics runs faster', () => {
    const onUpdate = vi.fn()
    const e = new SimFlightEngine(onUpdate)
    e.start({ lat: 60, lng: 17 }, 90, 0, 1000)
    vi.advanceTimersByTime(5_000)
    expect(onUpdate.mock.calls.length).toBe(5)
    e.stop()
  })
  it('still moves smoothly between emits (distance covered matches the speed)', () => {
    const last = { lat: 60 }
    const e = new SimFlightEngine((p) => { last.lat = p.lat })
    e.start({ lat: 60, lng: 17 }, 90, 0, 1000)
    vi.advanceTimersByTime(40_000)
    // 90 kt north for 40 s = 1 NM = 1/60 degree
    expect(last.lat - 60).toBeCloseTo(1 / 60, 3)
    e.stop()
  })
  it('emits at once for a manual step', () => {
    const onUpdate = vi.fn()
    const e = new SimFlightEngine(onUpdate)
    e.start({ lat: 60, lng: 17 })
    e.adjustHeading(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    e.stop()
  })
})
