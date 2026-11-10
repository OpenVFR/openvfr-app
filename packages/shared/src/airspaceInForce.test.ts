import { describe, it, expect } from 'vitest'
import { airspaceEnded } from './airspaceInForce'

const NOW = Date.parse('2026-11-10T12:00Z')

describe('airspaceEnded', () => {
  it('is true only for an ended SUP area', () => {
    expect(airspaceEnded({ source: 'sup', active_until: '2026-11-10T11:59Z' }, NOW)).toBe(true)
    expect(airspaceEnded({ source: 'sup', active_until: '2026-11-10T12:01Z' }, NOW)).toBe(false)
  })
  it('keeps a not yet started SUP area (planning ahead)', () => {
    expect(airspaceEnded({ source: 'sup', active_from: '2026-12-01T00:00Z', active_until: '2027-01-01T00:00Z' }, NOW)).toBe(false)
  })
  it('ignores areas that are not from a SUP, or have no / an unreadable end', () => {
    expect(airspaceEnded({ active_until: '2020-01-01T00:00Z' }, NOW)).toBe(false)
    expect(airspaceEnded({ source: 'sup' }, NOW)).toBe(false)
    expect(airspaceEnded({ source: 'sup', active_until: 'soon' }, NOW)).toBe(false)
    expect(airspaceEnded(null, NOW)).toBe(false)
  })
})
