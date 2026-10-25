import { describe, it, expect, vi, afterEach } from 'vitest'
import { pointElevationFt } from './pointElevation'

describe('pointElevationFt', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const api = (status = 200, elevation: number | null = 100) => {
    const fn = vi.fn(async (_u: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ status: 'OK', results: [{ elevation }] }), { status }))
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
  }

  it('DEM first: no API call when it has a value', async () => {
    const f = api()
    expect(await pointElevationFt(60, 15, { dem: { elevationFt: async () => 500 }, baseUrl: '' })).toBe(500)
    expect(f).not.toHaveBeenCalled()
  })

  it('no DEM value (or no DEM): API, with the extra headers', async () => {
    const f = api()
    const ft = await pointElevationFt(60, 15, { dem: { elevationFt: async () => null }, baseUrl: 'https://api.x', headers: async () => ({ Authorization: 'Bearer t' }) })
    expect(ft).toBe(328)
    expect(f.mock.calls[0]![0]).toContain('https://api.x/api/elevation/eudem25m?locations=60.00000%2C15.00000')
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer t')
  })

  it('DEM read error and API refusal: null, never throws', async () => {
    api(429)
    expect(await pointElevationFt(60, 15, { dem: { elevationFt: async () => { throw new Error('x') } }, baseUrl: '' })).toBeNull()
  })
})
