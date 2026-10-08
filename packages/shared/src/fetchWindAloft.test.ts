import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchWind } from './fetchWind'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

describe('fetchWind temperature', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the forecast temperature of the pressure level and requests it', async () => {
    const f = vi.fn(async () => ok({ current: { wind_speed_850hPa: 20, wind_direction_850hPa: 270, temperature_850hPa: 4.4 } }))
    vi.stubGlobal('fetch', f)
    const w = await fetchWind(57.11, 14.11, 6000)
    expect(w).toEqual({ dirDeg: 270, speedKts: 20, tempC: 4 })
    expect(String((f.mock.calls as unknown[][])[0][0])).toContain('temperature_850hPa')
  })
  it('uses 2 m temperature on the surface band and tolerates a missing temperature', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ current: { wind_speed_10m: 5, wind_direction_10m: 90 } })))
    const w = await fetchWind(57.22, 14.22, 500)
    expect(w).toEqual({ dirDeg: 90, speedKts: 5 })
  })
})
