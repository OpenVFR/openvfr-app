import { describe, it, expect } from 'vitest'
import { isObstacleFeature } from './snapLabels'

describe('isObstacleFeature', () => {
  it('does not mistake a church or mast with a height for an obstacle', () => {
    expect(isObstacleFeature({ kind: 'church', height_m: 45 } as never)).toBe(false)
    expect(isObstacleFeature({ kind: 'mast', elevation_ft: 120 })).toBe(false)
    expect(isObstacleFeature({ kind: 'windmill' })).toBe(false)
  })
  it('recognises obstacles by kind, or by a surveyed elevation for the shared kinds', () => {
    expect(isObstacleFeature({ kind: 'wind_turbine' })).toBe(true)
    expect(isObstacleFeature({ kind: 'chimney', elevation_ft: 90 })).toBe(true)
    expect(isObstacleFeature({ kind: 'chimney', height_m: 60 } as never)).toBe(false)
  })
})

import { snapIconName } from './snapLabels'
describe('snapIconName', () => {
  it('maps obstacle and landmark kinds to their map icon, others to none', () => {
    expect(snapIconName('OBS', 'wind_turbine')).toBe('obs-wind-turbine')
    expect(snapIconName('OBS', 'something-new')).toBe('obs-other')
    expect(snapIconName('LMK', 'church')).toBe('lmk-church')
    expect(snapIconName('AD', 'x')).toBeNull()
  })
})
