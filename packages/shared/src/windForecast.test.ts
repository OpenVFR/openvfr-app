import { describe, it, expect } from 'vitest'
import { interpolateWind, isForecastable } from './windForecast'

const series = { times: [0, 3600, 7200], speed: [10, 20, 20], dir: [270, 270, 90] }

describe('interpolateWind', () => {
  it('returns exact hour', () => {
    expect(interpolateWind(series, 3600)).toEqual({ dirDeg: 270, speedKts: 20 })
  })
  it('interpolates speed between hours', () => {
    expect(interpolateWind(series, 1800)).toEqual({ dirDeg: 270, speedKts: 15 })
  })
  it('handles direction wrap via vectors', () => {
    const w = interpolateWind({ times: [0, 3600], speed: [10, 10], dir: [350, 10] }, 1800)!
    expect(w.dirDeg === 0 || w.dirDeg === 359 || w.dirDeg === 1).toBe(true)
  })
  it('null outside series', () => {
    expect(interpolateWind(series, -1)).toBeNull()
    expect(interpolateWind(series, 7200 + 4000)).toBeNull()
  })
})

describe('isForecastable', () => {
  it('limits to 16 days ahead', () => {
    const now = Date.now()
    expect(isForecastable(new Date(now + 86_400_000), now)).toBe(true)
    expect(isForecastable(new Date(now + 20 * 86_400_000), now)).toBe(false)
  })
})

import { vi, afterEach } from 'vitest'
import { fetchWindForecastMany, clearWindForecastCache } from './windForecast'

describe('fetchWindForecastMany batching', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearWindForecastCache() })
  it('uses one multi-coordinate request per level and interpolates each point at its own time', async () => {
    const now = Math.floor(Date.now() / 3600_000) * 3600
    const hourly = (spd: number) => ({
      time: [now - 3600, now, now + 3600, now + 7200, now + 10800],
      wind_speed_925hPa: [spd, spd, spd, spd, spd], wind_direction_925hPa: [270, 270, 270, 270, 270],
    })
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ hourly: hourly(10) }, { hourly: hourly(20) }] }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const at = new Date((now + 3600) * 1000)
    const r = await fetchWindForecastMany([
      { lat: 58.1, lng: 15.1, altFt: 3000, at }, { lat: 58.5, lng: 15.5, altFt: 3000, at },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r).toEqual([{ dirDeg: 270, speedKts: 10 }, { dirDeg: 270, speedKts: 20 }])
  })
  it('separate levels use separate requests; out-of-horizon points are null without a request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const far = new Date(Date.now() + 40 * 86_400_000)
    const r = await fetchWindForecastMany([{ lat: 1, lng: 1, altFt: 3000, at: far }])
    expect(r).toEqual([null])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
