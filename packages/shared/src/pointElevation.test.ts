import { describe, it, expect } from 'vitest'
import { areaMaxElevationFt } from './pointElevation'

describe('areaMaxElevationFt', () => {
  it('the highest of the sampled points, from the DEM', async () => {
    // Ground rises to the north: 100 ft at the centre, 400 ft 500 m north.
    const dem = { elevationFt: async (lat: number) => Math.round(100 + (lat - 59) * 111_320 / 500 * 300) }
    const ft = await areaMaxElevationFt(59, 18, 500, { dem: dem as never, baseUrl: 'http://x' })
    expect(ft).toBe(400)
  })
  it('a hill beside a valley road counts', async () => {
    const dem = { elevationFt: async (_lat: number, lng: number) => (lng > 18.005 ? 500 : 100) }
    expect(await areaMaxElevationFt(59, 18, 500, { dem: dem as never, baseUrl: 'http://x' })).toBe(500)
  })
})
