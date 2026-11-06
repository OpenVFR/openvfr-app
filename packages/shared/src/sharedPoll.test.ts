import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribePoll } from './sharedPoll'

describe('subscribePoll', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('makes one request for several subscribers of a key', async () => {
    const fetcher = vi.fn(async () => 1)
    const a = vi.fn(), b = vi.fn()
    const offA = subscribePoll('k1', fetcher, 1000, a)
    const offB = subscribePoll('k1', fetcher, 1000, b)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(1)
    expect(b).toHaveBeenCalledWith(1)
    offA(); offB()
  })

  it('hands the last result to a later subscriber without a new request while it is fresh', async () => {
    const fetcher = vi.fn(async () => 'x')
    subscribePoll('k2', fetcher, 60_000, () => {})()
    await vi.advanceTimersByTimeAsync(0)
    const late = vi.fn()
    const off = subscribePoll('k2', fetcher, 60_000, late)
    expect(late).toHaveBeenCalledWith('x')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    off()
  })

  it('stops polling when the last subscriber leaves', async () => {
    const fetcher = vi.fn(async () => 1)
    const off = subscribePoll('k3', fetcher, 1000, () => {})
    await vi.advanceTimersByTimeAsync(0)
    off()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('polls again after the interval', async () => {
    const fetcher = vi.fn(async () => 1)
    const off = subscribePoll('k4', fetcher, 1000, () => {})
    await vi.advanceTimersByTimeAsync(2100)
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3)
    off()
  })
})
