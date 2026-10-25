import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchWindAloftAlongRoute, type WindAloftStatus } from './windAloft'
import { __resetOpenMeteoForTests, openMeteoJson } from './openMeteo'

const route = [{ lat: 63.0, lng: 14.0 }, { lat: 63.5, lng: 14.6 }]

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetOpenMeteoForTests()
})

describe('watchWindAloftAlongRoute', () => {
  it('reports retrying while Open-Meteo fails, then unavailable once retries are used up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    __resetOpenMeteoForTests({ random: () => 0 })
    const fetchMock = vi.fn(async () => new Response('{"error":true,"reason":"overloaded"}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const seen: WindAloftStatus[] = []
    const ac = new AbortController()
    watchWindAloftAlongRoute(route, 40, 6000, '', ac.signal, 6, (_c, s) => seen.push(s))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(seen).toEqual(['retrying', 'retrying', 'retrying', 'unavailable'])
    // At most one request + one retry per attempt; once the backoff passes
    // 60 s an attempt fails at once without a request.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8)
    ac.abort()
  })

  it('reports ok when its own request succeeds, even if another Open-Meteo request fails meanwhile', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/other')) return new Response('{"reason":"bad"}', { status: 400 })
      // Let the unrelated failure land while the route request is in flight.
      await new Promise((r) => setTimeout(r, 20))
      return new Response(JSON.stringify([
        { current: { wind_speed_10m: 5, wind_direction_10m: 90, wind_speed_925hPa: 10, wind_direction_925hPa: 100 } },
        { current: { wind_speed_10m: 6, wind_direction_10m: 95, wind_speed_925hPa: 11, wind_direction_925hPa: 105 } },
      ]), { status: 200 })
    }))
    const seen: WindAloftStatus[] = []
    const ac = new AbortController()
    const done = new Promise<void>((resolve) => {
      watchWindAloftAlongRoute([{ lat: 62.0, lng: 13.0 }, { lat: 62.5, lng: 13.6 }], 40, 2000, '', ac.signal, 6, (_c, s) => { seen.push(s); resolve() })
    })
    await openMeteoJson('/other').catch(() => {})
    await done
    expect(seen).toEqual(['ok'])
    ac.abort()
  })

  it('reports ok and stops once the data comes in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++n <= 2
      ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify([
        { current: { wind_speed_10m: 5, wind_direction_10m: 90, wind_speed_925hPa: 10, wind_direction_925hPa: 100 } },
        { current: { wind_speed_10m: 6, wind_direction_10m: 95, wind_speed_925hPa: 11, wind_direction_925hPa: 105 } },
      ]), { status: 200 }))))
    const seen: [WindAloftStatus, number][] = []
    const ac = new AbortController()
    watchWindAloftAlongRoute(route, 40, 2000, '', ac.signal, 6, (c, s) => seen.push([s, c.length]))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(seen[0]).toEqual(['retrying', 0])
    expect(seen[seen.length - 1][0]).toBe('ok')
    expect(seen[seen.length - 1][1]).toBeGreaterThan(0)
    expect(seen.length).toBe(2)
    ac.abort()
  })
})
