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

  it('reports a failed request to error listeners', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onError = vi.fn()
    const off = subscribePoll('k5', async () => { throw new Error('x') }, 1000, () => {}, onError)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    off()
  })

  it('keeps the interval from the last result when a subscriber returns', async () => {
    const fetcher = vi.fn(async () => 1)
    const off1 = subscribePoll('k6', fetcher, 1000, () => {})
    await vi.advanceTimersByTimeAsync(0)
    off1()
    await vi.advanceTimersByTimeAsync(600)
    const off2 = subscribePoll('k6', fetcher, 1000, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)       // fresh: no request yet
    await vi.advanceTimersByTimeAsync(450)          // 1050 ms after the result
    expect(fetcher).toHaveBeenCalledTimes(2)
    off2()
  })

  it('does not let an older request overwrite a newer result', async () => {
    let resolveOld: (v: number) => void = () => {}
    const slow = vi.fn(() => new Promise<number>((r) => { resolveOld = r }))
    const seen: number[] = []
    const off1 = subscribePoll('k7', slow, 1000, (d) => seen.push(d))
    off1()                                           // entry dropped with the request still out
    const off2 = subscribePoll('k7', async () => 2, 1000, (d) => seen.push(d))
    await vi.advanceTimersByTimeAsync(0)
    resolveOld(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([2])
    off2()
  })

  it('keeps only a bounded number of last results', async () => {
    for (let i = 0; i < 25; i++) {
      const off = subscribePoll(`cap${i}`, async () => i, 1000, () => {})
      await vi.advanceTimersByTimeAsync(0)
      off()
    }
    const f = vi.fn(async () => 0)
    const off = subscribePoll('cap0', f, 1000, () => {})   // evicted: fetched again
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalledTimes(1)
    off()
  })
})
