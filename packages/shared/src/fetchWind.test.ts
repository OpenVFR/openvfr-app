import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAmbientWx, fetchWindMany, fetchWindLevels } from './fetchWind'
import { __resetOpenMeteoForTests } from './openMeteo'

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
      dirDeg: 250, speedKts: 12, gustKts: 18, tempC: 14, cloudPct: 60, pressureHpa: 1013, precipMm: 0.2, gridDistNm: null,
    })
  })

  it('reports the distance to the model grid point Open-Meteo sampled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, {
      latitude: 58.45, longitude: 15.0,
      current: { wind_speed_10m: 5, wind_direction_10m: 90 },
    })))
    const result = await fetchAmbientWx(58.4, 15.0)
    // 0.05 deg latitude = 3 NM
    expect(result.gridDistNm).toBeCloseTo(3, 1)
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

describe('fetchWindMany', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    __resetOpenMeteoForTests()
  })

  it('requests one snapped point per 0.05 deg cell and answers every input from it', async () => {
    const fetchMock = vi.fn(async (_url: string) => mockResponse(200, [
      { current: { wind_speed_10m: 10, wind_direction_10m: 200 } },
      { current: { wind_speed_10m: 20, wind_direction_10m: 300 } },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchWindMany([
      { lat: 61.101, lng: 14.004 }, { lat: 61.099, lng: 13.996 }, { lat: 61.3, lng: 14.0 },
    ], null)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(fetchMock.mock.calls[0][0], 'http://x')
    expect(url.searchParams.get('latitude')).toBe('61.10,61.30')
    expect(url.searchParams.get('longitude')).toBe('14.00,14.00')
    expect(out).toEqual([
      { dirDeg: 200, speedKts: 10 }, { dirDeg: 200, speedKts: 10 }, { dirDeg: 300, speedKts: 20 },
    ])
  })

  it('winds aloft stay within 10 variables (one Open-Meteo call per location), even for high charts', async () => {
    const fetchMock = vi.fn(async (_url: string) => mockResponse(200, { current: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchWindLevels([{ lat: 63.9, lng: 15.9 }], 30000)
    const vars = new URL(fetchMock.mock.calls[0][0], 'http://x').searchParams.get('current')!.split(',')
    expect(vars.length).toBe(10)
    expect(vars).toContain('wind_speed_600hPa')
    expect(vars).not.toContain('wind_speed_500hPa')
  })

  it('falls back to a recent reading when the request fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, [{ current: { wind_speed_10m: 7, wind_direction_10m: 90 } }])))
    await fetchWindMany([{ lat: 62.2, lng: 15.2 }], null)
    // 40 min later: the 30-min cache has expired and Open-Meteo answers 400.
    vi.setSystemTime(Date.now() + 40 * 60_000)
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(400, { reason: 'bad' })))
    expect(await fetchWindMany([{ lat: 62.2, lng: 15.2 }], null)).toEqual([{ dirDeg: 90, speedKts: 7 }])
    // Over an hour past expiry the reading is too old to pass for current.
    vi.setSystemTime(Date.now() + 61 * 60_000)
    expect(await fetchWindMany([{ lat: 62.2, lng: 15.2 }], null)).toEqual([null])
  })
})
