import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  openMeteoJson, openMeteoCooldownMs, openMeteoFailureCount, throttleDelayMs, snapCoord,
  OpenMeteoError, __resetOpenMeteoForTests,
} from './openMeteo'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  __resetOpenMeteoForTests({ now: () => Date.now(), random: () => 0.5 })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('throttleDelayMs', () => {
  const at = Date.UTC(2026, 0, 1, 10, 20, 30)
  it('backs off exponentially with jitter, capped', () => {
    expect(throttleDelayMs(0, null, '', at, 0)).toBe(2500)
    expect(throttleDelayMs(0, null, '', at, 1)).toBe(5000)
    expect(throttleDelayMs(1, null, '', at, 1)).toBe(15000)
    expect(throttleDelayMs(9, null, '', at, 1)).toBe(300000)
  })
  it('honours Retry-After (seconds and date)', () => {
    expect(throttleDelayMs(0, '30', '', at, 0)).toBe(30000)
    expect(throttleDelayMs(0, new Date(at + 12000).toUTCString(), '', at, 0)).toBe(12000)
  })
  it('waits for the next window on an explicit limit', () => {
    expect(throttleDelayMs(0, null, 'Minutely API request limit exceeded', at, 0)).toBe(35000)
    expect(throttleDelayMs(0, null, 'Hourly API request limit exceeded', at, 0)).toBe(39 * 60_000 + 30_000 + 30_000)
    expect(throttleDelayMs(0, null, 'Daily API request limit exceeded', at, 0)).toBe(Date.UTC(2026, 0, 2) - at + 60_000)
  })
})

describe('openMeteoJson', () => {
  it('shares one request between identical concurrent callers', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ a: 1 })))
    const [a, b] = await Promise.all([openMeteoJson('/u'), openMeteoJson('/u')])
    expect(a).toEqual({ a: 1 })
    expect(b).toEqual({ a: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('runs at most two requests at once', async () => {
    const resolvers: ((r: Response) => void)[] = []
    fetchMock.mockImplementation(() => new Promise<Response>((r) => resolvers.push(r)))
    const ps = ['/1', '/2', '/3'].map((u) => openMeteoJson(u))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resolvers[0](json({}))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    resolvers[1](json({})); resolvers[2](json({}))
    await Promise.all(ps)
  })

  it('closes the gate for everyone on a 503 and retries once after it reopens', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: true, reason: 'overloaded' }, 503))
      .mockImplementation(() => Promise.resolve(json({ ok: 1 })))
    const p = openMeteoJson('/a')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(openMeteoCooldownMs()).toBe(3750)
    // Another caller is held back by the same gate.
    const q = openMeteoJson('/b')
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toEqual({ ok: 1 })
    await expect(q).resolves.toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(openMeteoFailureCount()).toBe(0)
  })

  it('a 503 storm: queued requests wait for the gate, and one incident escalates once', async () => {
    const sentWhileClosed: number[] = []
    let rnd = 0
    // Varying jitter: a later answer from the same wave pushes the gate further out.
    __resetOpenMeteoForTests({ now: () => Date.now(), random: () => (rnd = (rnd + 0.37) % 1) })
    fetchMock.mockImplementation(() => {
      if (openMeteoCooldownMs() > 0) sentWhileClosed.push(openMeteoCooldownMs())
      return Promise.resolve(json({ error: true, reason: 'overloaded' }, 503))
    })
    const ps = [1, 2, 3, 4, 5].map((i) => openMeteoJson(`/s${i}`).catch((e) => e.status))
    await vi.advanceTimersByTimeAsync(0)
    // Only the two concurrent slots reached Open-Meteo; the rest wait.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Both answers belong to one incident: base backoff (2.5-5 s), not 15 s.
    expect(openMeteoCooldownMs()).toBeLessThanOrEqual(5000)
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all(ps)
    // 5 requests + at most one retry each, spread over the backoff.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10)
    expect(sentWhileClosed).toEqual([])
  })

  it('gives up after one retry and counts the failure', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({}, 503)))
    const p = openMeteoJson('/a')
    const check = expect(p).rejects.toMatchObject({ name: 'OpenMeteoError', status: 503, throttled: true })
    await vi.advanceTimersByTimeAsync(10_000)
    await check
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(openMeteoFailureCount()).toBe(1)
  })

  it('fails fast instead of waiting hours for a daily limit', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: true, reason: 'Daily API request limit exceeded' }, 429))
    await expect(openMeteoJson('/a')).rejects.toBeInstanceOf(OpenMeteoError)
    expect(openMeteoCooldownMs()).toBeGreaterThan(60_000)
    await expect(openMeteoJson('/b')).rejects.toMatchObject({ status: null, throttled: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry other HTTP errors or close the gate', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ reason: 'bad' }, 400)))
    await expect(openMeteoJson('/a')).rejects.toMatchObject({ status: 400, throttled: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(openMeteoCooldownMs()).toBe(0)
  })

  it('retries a network error once without closing the gate', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(() => Promise.resolve(json({ ok: 1 })))
    const p = openMeteoJson('/a')
    await vi.advanceTimersByTimeAsync(2000)
    await expect(p).resolves.toEqual({ ok: 1 })
    expect(openMeteoCooldownMs()).toBe(0)
  })

  it('aborts the shared request only when every caller has aborted', async () => {
    let seen: AbortSignal | undefined
    fetchMock.mockImplementation((_u: string, init: RequestInit) => {
      seen = init.signal!
      return new Promise<Response>(() => {})
    })
    const a = new AbortController(), b = new AbortController()
    const pa = openMeteoJson('/u', a.signal)
    const pb = openMeteoJson('/u', b.signal)
    await vi.advanceTimersByTimeAsync(0)
    a.abort()
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen!.aborted).toBe(false)
    b.abort()
    await expect(pb).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen!.aborted).toBe(true)
  })
})

describe('snapCoord', () => {
  it('snaps to 0.05 degrees', () => {
    expect(snapCoord(59.5308)).toBe(59.55)
    expect(snapCoord(18.2694)).toBe(18.25)
    expect(snapCoord(-0.024)).toBe(-0)
  })
})
