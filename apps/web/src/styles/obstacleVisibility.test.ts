import { describe, it, expect } from 'vitest'
import { OBSTACLE_MIN_HEIGHT_BY_ZOOM as STOPS, obstacleIconSize, obstacleLabelText } from './map-style'

describe('obstacle visibility by height', () => {
  it('thresholds fall and sizes grow with zoom, everything shows at high zoom', () => {
    for (let i = 1; i < STOPS.length; i++) {
      expect(STOPS[i].zoom).toBeGreaterThan(STOPS[i - 1].zoom)
      expect(STOPS[i].minHeightM).toBeLessThanOrEqual(STOPS[i - 1].minHeightM)
      expect(STOPS[i].size).toBeGreaterThanOrEqual(STOPS[i - 1].size)
    }
    expect(STOPS[STOPS.length - 1].minHeightM).toBe(0)
  })

  it('icon-size is a top-level zoom interpolation (the only form MapLibre allows with zoom) with one output per stop', () => {
    const e = obstacleIconSize()
    expect(e.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']])
    expect(e.length).toBe(3 + STOPS.length * 2)
  })

  it('an unknown height (height_m 0) is never hidden: the size expression keeps it for every threshold', () => {
    const json = JSON.stringify(obstacleIconSize())
    expect(json).toContain('["<=",["to-number",["get","height_m"],0],0]')
  })

  it('label is a case expression ending in an empty string', () => {
    const e = obstacleLabelText()
    expect(e[0]).toBe('case')
    expect(e[e.length - 1]).toBe('')
  })
})
