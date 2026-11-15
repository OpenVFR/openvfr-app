import { describe, it, expect } from 'vitest'
import { aerodromeId } from './aerodromeId'

describe('aerodromeId', () => {
  it('is the ICAO code, else the local id of an aerodrome without one', () => {
    expect(aerodromeId({ icao: 'ESMS', local_id: 'x', runways: [] })).toBe('ESMS')
    expect(aerodromeId({ icao: null, local_id: 'ESMARS', runways: [] })).toBe('ESMARS')
    expect(aerodromeId({ local_id: 'ESMARS', runways: '[]' })).toBe('ESMARS')      // nested values may arrive as JSON text
  })
  it('is empty for anything that is not an aerodrome', () => {
    expect(aerodromeId({ local_id: 'x', kind: 'wind_turbine', elevation_ft: 169 })).toBe('')      // an obstacle: no runways
    expect(aerodromeId({ icao: '', runways: [] })).toBe('')
    expect(aerodromeId(null)).toBe('')
  })
})
