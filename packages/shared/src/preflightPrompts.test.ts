import { describe, it, expect } from 'vitest'
import { computePrompts, routeCountries, unambiguousRegion, regionFromIcao, formatPreflightPrompt } from './preflightPrompts'

const stockholm = { lat: 59.65, lng: 17.94, name: 'ESSA' }
const gothenburg = { lat: 57.66, lng: 12.28, name: 'ESGG' }
const london = { lat: 51.47, lng: -0.45, name: 'EGLL' }
const paris = { lat: 49.0, lng: 2.55, name: 'LFPG' }
const wind = { dirDeg: 270, speedKts: 10 }
const codes = (p: { code: string }[]) => p.map((x) => x.code)

describe('unambiguousRegion', () => {
  it('finds a single region', () => {
    expect(unambiguousRegion(london)).toBe('gb')
    expect(unambiguousRegion(paris)).toBe('fr')
  })
  it('is null in the middle of the sea', () => {
    expect(unambiguousRegion({ lat: 30, lng: -40 })).toBeNull()
  })
})

describe('regionFromIcao', () => {
  it('maps aerodrome indicators', () => {
    expect(regionFromIcao('ESSA')).toBe('se')
    expect(regionFromIcao('EDDM')).toBe('de')
  })
  it('ignores other names and shared prefixes', () => {
    expect(regionFromIcao('ALPHA')).toBeNull()
    expect(regionFromIcao(undefined)).toBeNull()
    expect(regionFromIcao('LYBE')).toBeNull()
  })
})

describe('computePrompts', () => {
  it('has nothing for a domestic route with winds', () => {
    expect(computePrompts({ waypoints: [stockholm, gothenburg], legWinds: [wind] })).toEqual([])
  })
  it('prompts when winds are missing, not while loading', () => {
    const base = { waypoints: [stockholm, gothenburg], legWinds: [null] }
    expect(codes(computePrompts(base))).toEqual(['winds-unavailable'])
    expect(computePrompts({ ...base, windsLoading: true })).toEqual([])
  })
  it('counts partial wind coverage', () => {
    const p = computePrompts({ waypoints: [stockholm, gothenburg, stockholm], legWinds: [wind, null] })
    expect(p[0].detail).toContain('1 of 2')
  })
  it('skips the winds prompt when no winds are passed', () => {
    expect(computePrompts({ waypoints: [stockholm, gothenburg] })).toEqual([])
  })
  it('flags an international border', () => {
    const p = computePrompts({ waypoints: [paris, { lat: 50.9, lng: 4.5, name: 'EBBR' }], legWinds: [wind] })
    expect(codes(p)).toEqual(['flightplan-likely'])
  })
  it('adds the UK GAR notice for UK <-> abroad only', () => {
    expect(codes(computePrompts({ waypoints: [london, paris], legWinds: [wind] }))).toEqual(['flightplan-likely', 'gar-uk'])
    expect(codes(computePrompts({ waypoints: [stockholm, gothenburg] }))).toEqual([])
  })
  it('routeCountries keeps route order, no duplicates', () => {
    expect(routeCountries([stockholm, gothenburg, paris])).toEqual(['se', 'fr'])
  })
  it('needs two waypoints', () => {
    expect(computePrompts({ waypoints: [stockholm], legWinds: [] })).toEqual([])
  })
})

describe('formatPreflightPrompt: the English of every prompt code', () => {
  it('words each code', () => {
    expect(formatPreflightPrompt({ code: 'winds-unavailable', params: { missing: 2, legs: 2 } })).toMatchObject({ code: 'winds-unavailable', title: 'Wind data unavailable',
      detail: 'No wind is known for this route, so time and fuel assume still air. Enter a wind or refresh the forecast.' })
    expect(formatPreflightPrompt({ code: 'winds-unavailable', params: { missing: 1, legs: 3 } }).detail).toBe('No wind is known for 1 of 3 legs; time and fuel assume still air on those.')
    expect(formatPreflightPrompt({ code: 'flightplan-likely', params: {} })).toMatchObject({ title: 'Route crosses a national border',
      detail: 'A flight plan may be required for a flight between these countries. Check the national rules for each.' })
    expect(formatPreflightPrompt({ code: 'gar-uk', params: {} })).toMatchObject({ title: 'UK General Aviation Report',
      detail: 'Flights between the UK and another country normally need a General Aviation Report filed in advance. Check the deadline and where to submit it.' })
  })
})
