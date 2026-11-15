import { describe, it, expect } from 'vitest'
import { airspaceCategory, applyAirspaceLevel, noticeWanted, resolveAirspaceLevels, DEFAULT_AIRSPACE_LEVELS } from './airspaceAlertLevel'

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
    expect(airspaceCategory('GLDR', '')).toBe('glider')
    expect(airspaceCategory('GLDR', 'GLDR')).toBe('glider')
    expect(airspaceCategory('MODEL', 'MODEL')).toBe('model')
    expect(airspaceCategory('GLDR', 'SOAR')).toBe('soaring')       // a federation's soaring sector: class GLDR, type SOAR
    expect(airspaceCategory('X', '')).toBe('activity')             // anything else of that kind
  })

  it('keeps glider sites and the large soaring sectors apart: the sectors are ignored by default', () => {
    const L = DEFAULT_AIRSPACE_LEVELS
    expect(applyAirspaceLevel({ cls: 'GLDR', type: 'GLDR', severity: 'yellow' as const }, L)?.severity).toBe('blue')    // a glider site: quiet chip
    expect(applyAirspaceLevel({ cls: 'GLDR', type: 'SOAR', severity: 'yellow' as const }, L)).toBeNull()                 // a sector: no warning
    const glider = resolveAirspaceLevels({ soaring: 'info' })
    expect(applyAirspaceLevel({ cls: 'GLDR', type: 'SOAR', severity: 'yellow' as const }, glider)?.severity).toBe('blue')
  })

  it('gives entered / left notices for everything except sectors that are set to ignore', () => {
    const L = DEFAULT_AIRSPACE_LEVELS
    expect(noticeWanted('GLDR', 'SOAR', L)).toBe(false)
    expect(noticeWanted('GLDR', 'SOAR', resolveAirspaceLevels({ soaring: 'info' }))).toBe(true)
    for (const [c, t] of [['GLDR', 'GLDR'], ['MODEL', 'MODEL'], ['C', 'CTR'], ['E', 'TMA'], ['R', 'R']]) expect(noticeWanted(c, t, L)).toBe(true)   // unchanged
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
  it('carries the old combined "activity" choice over to glider and model areas, not to the sectors', () => {
    const l = resolveAirspaceLevels({ activity: 'ignore' })
    expect(l).toMatchObject({ glider: 'ignore', model: 'ignore', soaring: 'ignore', activity: 'ignore' })
    const k = resolveAirspaceLevels({ activity: 'alert' })
    expect(k).toMatchObject({ glider: 'alert', model: 'alert', soaring: 'ignore' })          // the sectors keep their own default
    const own = resolveAirspaceLevels({ activity: 'alert', glider: 'info' })
    expect(own).toMatchObject({ glider: 'info', model: 'alert' })                           // an explicit new choice wins
  })
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
