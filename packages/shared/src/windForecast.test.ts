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
