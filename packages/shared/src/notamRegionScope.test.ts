import { describe, it, expect } from 'vitest'
import {
  notamRegionsFor, sampleRoute, parseRegionsParam, regionsParam,
  filterNotamsToRegions, notamInRegions, regionScope,
} from './notamRegionScope'

const stockholm = { lat: 59.35, lng: 17.94 }
const malmo     = { lat: 55.6,  lng: 13.0 }
const hamburg   = { lat: 53.55, lng: 9.99 }

const base = { lat: null, lon: null, radiusNm: null, polygon: null, affectedFir: null, icaoLocation: null }

describe('notamRegionsFor', () => {
  it('selected region only, when nothing else is known', () => {
    expect(notamRegionsFor({ selected: ['se'] })).toEqual(['se'])
  })
  it('keeps every selected region (multi-country selection)', () => {
    expect(notamRegionsFor({ selected: ['se', 'no', 'fi'] })).toEqual(['fi', 'no', 'se'])
  })
  it('drops unknown selected codes', () => {
    expect(notamRegionsFor({ selected: ['se', 'xx'] })).toEqual(['se'])
  })
  it('adds regions a route crosses without a waypoint in them', () => {
    // Stockholm -> Hamburg passes Denmark's bbox; neither endpoint is in
    // it, so only leg sampling finds it.
    expect(notamRegionsFor({ selected: [], route: [stockholm] })).not.toContain('dk')
    expect(notamRegionsFor({ selected: [], route: [hamburg] })).not.toContain('dk')
    const r = notamRegionsFor({ selected: ['se'], route: [stockholm, hamburg] })
    expect(r).toContain('se')
    expect(r).toContain('de')
    expect(r).toContain('dk')
  })
  it('adds the region of the current position', () => {
    expect(notamRegionsFor({ selected: ['se'], position: hamburg })).toContain('de')
  })
  it('is sorted and de-duplicated', () => {
    const r = notamRegionsFor({ selected: ['se', 'se'], route: [stockholm, stockholm] })
    expect(r).toEqual([...new Set(r)].sort())
  })
})

describe('sampleRoute', () => {
  it('keeps endpoints and samples at least every 10 NM', () => {
    const pts = sampleRoute([malmo, hamburg])
    expect(pts[0]).toEqual(malmo)
    expect(pts[pts.length - 1]).toEqual(hamburg)
    expect(pts.length).toBeGreaterThan(10)
  })
  it('single point passes through', () => {
    expect(sampleRoute([stockholm])).toEqual([stockholm])
  })
})

describe('parseRegionsParam / regionsParam', () => {
  it('absent or empty -> null', () => {
    expect(parseRegionsParam(undefined)).toBeNull()
    expect(parseRegionsParam('')).toBeNull()
  })
  it('normalises case and duplicates', () => {
    expect(parseRegionsParam('SE,dk,se')).toEqual(['se', 'dk'])
  })
  it('rejects unknown codes', () => {
    expect(parseRegionsParam('se,zz')).toEqual({ error: 'Unknown region: zz' })
  })
  it('builds a stable sorted param', () => {
    expect(regionsParam(['se', 'dk', 'se'])).toBe('dk,se')
  })
})

describe('notamInRegions', () => {
  const se = regionScope(['se'])

  it('keeps NOTAMs filed in the region regardless of geometry', () => {
    expect(notamInRegions({ ...base, affectedFir: 'ESAA' }, se)).toBe(true)
    expect(notamInRegions({ ...base, icaoLocation: 'ESSA', lat: 0, lon: 0, radiusNm: 5 }, se)).toBe(true)
  })

  it('drops other countries\' positionless NOTAMs', () => {
    expect(notamInRegions({ ...base, affectedFir: 'LEMM' }, se)).toBe(false)
  })

  it('keeps a foreign circle that reaches into the region (cross-border)', () => {
    // German exercise area over the southern Baltic, 85 NM radius, centre
    // ~60 NM south of Sweden's bbox.
    expect(notamInRegions({ ...base, icaoLocation: 'EDWW', affectedFir: 'EDWW', lat: 54.3, lon: 12.1833, radiusNm: 85 }, se)).toBe(true)
  })

  it('drops a foreign circle far away', () => {
    expect(notamInRegions({ ...base, icaoLocation: 'LEMM', affectedFir: 'LEMM', lat: 40.4, lon: -3.7, radiusNm: 20 }, se)).toBe(false)
  })

  it('does not let a whole-FIR sentinel radius match everything', () => {
    expect(notamInRegions({ ...base, affectedFir: 'LGGG', lat: 38, lon: 23.7, radiusNm: 999 }, se)).toBe(false)
  })

  it('keeps a foreign polygon with a vertex inside the region', () => {
    const polygon = { type: 'Polygon' as const, coordinates: [[[14, 55], [15, 55], [15, 56], [14, 56], [14, 55]]] }
    expect(notamInRegions({ ...base, affectedFir: 'EDWW', polygon }, se)).toBe(true)
  })

  it('keeps a NOTAM with no filing location and no geometry', () => {
    expect(notamInRegions(base, se)).toBe(true)
  })
})

describe('filterNotamsToRegions', () => {
  it('filters a mixed list to Sweden + Denmark', () => {
    const list = [
      { ...base, affectedFir: 'ESAA' },
      { ...base, affectedFir: 'EKDK' },
      { ...base, affectedFir: 'LIRR' },
    ]
    expect(filterNotamsToRegions(list, ['se', 'dk']).map(n => n.affectedFir)).toEqual(['ESAA', 'EKDK'])
  })
})
