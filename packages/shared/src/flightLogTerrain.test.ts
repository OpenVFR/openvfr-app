import { describe, it, expect } from 'vitest'
import { fetchTerrainProfile } from './virtualRadarCalc'

// ~60 NM east-west at 60° N.
const path = [{ lat: 60, lng: 15 }, { lat: 60, lng: 17 }]
const dem = { elevationFt: async (lat: number, lng: number) => Math.round(100 + lat + lng) }

describe('fetchTerrainProfile denseLookup', () => {
  it('samples the local DEM every ~0.5 NM for a flight log, never asking the API', async () => {
    const pts = await fetchTerrainProfile(path, 'http://no-api.invalid', undefined, dem, { preferLookup: true, denseLookup: true })
    expect(pts.length).toBeGreaterThan(110)
    expect(pts[1].distNm - pts[0].distNm).toBeLessThan(0.6)
  })

  it('keeps ~1 NM spacing without it', async () => {
    const pts = await fetchTerrainProfile(path, 'http://no-api.invalid', undefined, dem, { preferLookup: true })
    expect(pts.length).toBeLessThanOrEqual(100)
  })
})
