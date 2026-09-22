import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAmbientWx } from './fetchWind'

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

describe('fetchAmbientWx', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses wind + temp/cloud/pressure/precip from the Open-Meteo current block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, {
      current: {
        wind_speed_10m: 12, wind_direction_10m: 250, wind_gusts_10m: 18,
        temperature_2m: 14, cloud_cover: 60, surface_pressure: 1013, precipitation: 0.2,
      },
    })))
    // Distinct coordinates from other fetchWind/fetchAmbientWx tests -- both
    // have their own 30-min in-memory caches keyed by rounded lat/lng.
    const result = await fetchAmbientWx(58.1, 15.1)
    expect(result).toEqual({
      dirDeg: 250, speedKts: 12, gustKts: 18, tempC: 14, cloudPct: 60, pressureHpa: 1013, precipMm: 0.2,
    })
  })

  it('reports dirDeg: null when wind is calm (speed 0) instead of a meaningless direction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, {
      current: {
        wind_speed_10m: 0, wind_direction_10m: 0, wind_gusts_10m: 0,
        temperature_2m: 10, cloud_cover: 0, surface_pressure: 1020, precipitation: 0,
      },
    })))
    const result = await fetchAmbientWx(58.2, 15.2)
    expect(result.dirDeg).toBeNull()
    expect(result.speedKts).toBe(0)
  })

  it('throws on a non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(500, {})))
    await expect(fetchAmbientWx(58.3, 15.3)).rejects.toThrow('Open-Meteo HTTP 500')
  })
})
