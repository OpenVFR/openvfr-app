import { describe, it, expect } from 'vitest'
import { airspaceCategory, applyAirspaceLevel, resolveAirspaceLevels, DEFAULT_AIRSPACE_LEVELS } from './airspaceAlertLevel'

const a = (cls: string, type = '', severity: 'red' | 'yellow' | 'blue' = 'yellow') => ({ cls, type, severity })

describe('airspaceCategory', () => {
  it('maps classes and types', () => {
    expect(airspaceCategory('R', 'D')).toBe('restricted')
    expect(airspaceCategory('TRA', '')).toBe('restricted')
    expect(airspaceCategory('A', '')).toBe('classA')
    expect(airspaceCategory('C', 'CTR')).toBe('controlled')
    expect(airspaceCategory('E', '')).toBe('classEF')
    expect(airspaceCategory('', 'ATZ')).toBe('zones')
    expect(airspaceCategory('RMZ', '')).toBe('zones')
    expect(airspaceCategory('GLDR', '')).toBe('activity')
  })
})

describe('applyAirspaceLevel', () => {
  const L = DEFAULT_AIRSPACE_LEVELS
  it('keeps default alerts at their severity', () => {
    expect(applyAirspaceLevel(a('R'), L)?.severity).toBe('red')
    expect(applyAirspaceLevel(a('C'), L)?.severity).toBe('yellow')
  })
  it('drops ignored categories (class E/F by default)', () => expect(applyAirspaceLevel(a('E'), L)).toBeNull())
  it('turns info into a blue chip', () => expect(applyAirspaceLevel(a('', 'RMZ', 'yellow'), L)?.severity).toBe('blue'))
  it('honours a changed level', () => {
    const l = resolveAirspaceLevels({ classEF: 'alert', controlled: 'info' })
    expect(applyAirspaceLevel(a('E'), l)?.severity).toBe('yellow')
    expect(applyAirspaceLevel(a('C'), l)?.severity).toBe('blue')
  })
})

describe('resolveAirspaceLevels', () => {
  it('never lets restricted or class A be ignored', () => {
    const l = resolveAirspaceLevels({ restricted: 'ignore', classA: 'ignore' })
    expect(l.restricted).toBe('info')
    expect(l.classA).toBe('info')
  })
  it('falls back to defaults for missing or bad values', () => {
    expect(resolveAirspaceLevels({ zones: 'loud' })).toEqual(DEFAULT_AIRSPACE_LEVELS)
    expect(resolveAirspaceLevels(null)).toEqual(DEFAULT_AIRSPACE_LEVELS)
  })
})
