import { describe, it, expect } from 'vitest'
import { parseCoordinate, formatCoordinate } from './coordinateParse'

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6)

function expectPos(input: string, lat: number, lng: number) {
  const r = parseCoordinate(input)
  expect(r, input).not.toBeNull()
  close(r!.lat, lat)
  close(r!.lng, lng)
  return r!
}

describe('parseCoordinate — decimal degrees', () => {
  it('space, comma, degree-sign separators', () => {
    expectPos('59.123 18.456', 59.123, 18.456)
    expectPos('59.123,18.456', 59.123, 18.456)
    expectPos('59.123°, 18.456°', 59.123, 18.456)
  })
  it('signed hemispheres', () => {
    const r = expectPos('-33.5 -151.25', -33.5, -151.25)
    expect(r.format).toEqual({ style: 'DD', hemi: 'none', lngFirst: false })
  })
  it('leading and trailing hemisphere letters', () => {
    expect(expectPos('N59.123 E18.456', 59.123, 18.456).format.hemi).toBe('leading')
    expect(expectPos('59.123N 18.456E', 59.123, 18.456).format.hemi).toBe('trailing')
    expectPos('s33.5 w70.25', -33.5, -70.25)
  })
  it('European decimal commas', () => {
    expectPos('59,123 18,456', 59.123, 18.456)
  })
})

describe('parseCoordinate — DDM / DMS', () => {
  it('degrees + decimal minutes', () => {
    const r = expectPos("N59°07.38' E018°27.36'", 59 + 7.38 / 60, 18 + 27.36 / 60)
    expect(r.format.style).toBe('DDM')
    expectPos('59 07.38N 018 27.36E', 59 + 7.38 / 60, 18 + 27.36 / 60)
  })
  it('degrees minutes seconds', () => {
    const lat = 59 + 7 / 60 + 22 / 3600
    const lng = 18 + 27 / 60 + 21 / 3600
    expect(expectPos(`59°07'22"N 18°27'21"E`, lat, lng).format.style).toBe('DMS')
    expectPos('59 07 22 N 018 27 21 E', lat, lng)
    expectPos('59°07′22″N 18°27′21″E', lat, lng)
  })
  it('signed DDM without letters', () => {
    expectPos('-33 30.0 151 15.0', -33.5, 151.25)
  })
})

describe('parseCoordinate — compact NOTAM/AIP form', () => {
  it('DDMM / DDDMM', () => {
    const r = expectPos('5939N01756E', 59 + 39 / 60, 17 + 56 / 60)
    expect(r.format).toEqual({ style: 'COMPACT', hemi: 'trailing', lngFirst: false, compactSeconds: false })
  })
  it('DDMMSS / DDDMMSS', () => {
    const r = expectPos('593922N0175612E', 59 + 39 / 60 + 22 / 3600, 17 + 56 / 60 + 12 / 3600)
    expect(r.format.compactSeconds).toBe(true)
  })
  it('fractional minutes', () => {
    expectPos('5939.5N01756.25E', 59 + 39.5 / 60, 17 + 56.25 / 60)
  })
  it('rejects compact without hemisphere letters', () => {
    expect(parseCoordinate('5939 01756')).toBeNull()
  })
})

describe('parseCoordinate — longitude first', () => {
  it('detects axis from letters', () => {
    const r = expectPos('E018.456 N59.123', 59.123, 18.456)
    expect(r.format.lngFirst).toBe(true)
    expectPos('01756E5939N', 59 + 39 / 60, 17 + 56 / 60)
  })
})

describe('parseCoordinate — rejects', () => {
  it.each([
    '', 'ESSB', 'Visby', '59.1', '1234',
    '91 18', '59 181', '59 61.0N 018 00.0E', '59 07 61N 018 00 00E',
    'N59 N18', 'E59 W18', 'N59 -18 E', '59.5 07 18 00',
    '59N 018 27.36E', // mixed styles per axis
    '5939N 018.5E',   // compact + DD mixed
  ])('%s', (s) => expect(parseCoordinate(s)).toBeNull())
})

describe('formatCoordinate — echo typed style', () => {
  it('round-trips each style', () => {
    for (const s of [
      'N59.12300° E18.45600°',
      "59° 07.380'N 018° 27.360'E",
      `59° 07' 22.0"N 018° 27' 21.0"E`,
      '5939N01756E',
      '593922N0175612E',
      'E18.45600° N59.12300°',
    ]) {
      const r = parseCoordinate(s)!
      expect(formatCoordinate(r.lat, r.lng, r.format), s).toBe(s)
    }
  })
  it('signed DD keeps minus signs', () => {
    const r = parseCoordinate('-33.5 -70.25')!
    expect(formatCoordinate(r.lat, r.lng, r.format)).toBe('-33.50000° -70.25000°')
  })
  it('carries rounding instead of printing 60 minutes', () => {
    const f = { style: 'DDM' as const, hemi: 'trailing' as const, lngFirst: false }
    expect(formatCoordinate(59.99999999, 18, f)).toBe("60° 00.000'N 018° 00.000'E")
  })
})

import { findCoordinates } from './coordinateParse'

describe('findCoordinates', () => {
  const one = (t: string) => {
    const r = findCoordinates(t)
    expect(r).toHaveLength(1)
    return r[0]!
  }
  it('fixture 6: decimal minutes', () => {
    const c = one('5939.5N 01756.2E')
    expect(c.lat).toBeCloseTo(59.658333, 5)
    expect(c.lng).toBeCloseTo(17.936667, 5)
  })
  it('fixture 7: spaced, degree-mark and hemisphere-first DMS', () => {
    for (const t of ['59°39\'22"N 017°56\'12"E', '59 39 22 N 017 56 12 E', 'N593922 E0175612', 'N 59 39 22 E 017 56 12', 'N59°39\'22" E017°56\'12"']) {
      const c = one(t)
      expect(c.lat).toBeCloseTo(59.656111, 5)
      expect(c.lng).toBeCloseTo(17.936667, 5)
    }
  })
  it('degree-mark decimal minutes', () => {
    const c = one('59°07.38\'N 018°27.36\'E')
    expect(c.lat).toBeCloseTo(59.123, 4)
    expect(c.lng).toBeCloseTo(18.456, 4)
  })
  it('fixture 8: decimal comma on seconds', () => {
    const c = one('593922,5N 0175612,5E')
    expect(c.lat).toBeCloseTo(59.65625, 5)
    expect(c.lng).toBeCloseTo(17.936806, 5)
  })
  it('fixture 9: longitude missing its leading zero', () => {
    const c = one('593922N 175612E')
    expect(c.lat).toBeCloseTo(59.656111, 5)
    expect(c.lng).toBeCloseTo(17.936667, 5)
  })
  it('fixture 10: minutes >= 60 rejected, neighbours kept', () => {
    expect(findCoordinates('596122N 0175612E')).toEqual([])
    const r = findCoordinates('596122N 0175612E - 593922N 0175612E')
    expect(r).toHaveLength(1)
    expect(r[0]!.start).toBe(19)
    expect(findCoordinates('593961N 0175612E')).toEqual([])
  })
  it('fixture 18: numbers that are not coordinates', () => {
    expect(findCoordinates('TEL 0046 70 123 456 FAX 070.123')).toEqual([])
    expect(findCoordinates('RWY 09 WIND 250.5 KT 118.105 MHZ')).toEqual([])
    const c = one('5939N 01756E')
    expect(c.lat).toBeCloseTo(59.65, 5)
    expect(c.lng).toBeCloseTo(17.933333, 5)
  })
  it('southern / western hemispheres', () => {
    const c = one('335000S 0701500W')
    expect(c.lat).toBeCloseTo(-33.8333, 3)
    expect(c.lng).toBeCloseTo(-70.25, 3)
  })
  it('reports offsets for each match in a list', () => {
    const t = 'OBST 551234N 0141234E, 551300N 0141300E.'
    const r = findCoordinates(t)
    expect(r.map(c => t.slice(c.start, c.end))).toEqual(['551234N 0141234E', '551300N 0141300E'])
  })
  it('no glued letters or digits at either end', () => {
    expect(findCoordinates('5939N 01756EZ')).toEqual([])
    expect(findCoordinates('15939N 01756E')).toEqual([])
  })
})

describe('findCoordinates: robustness', () => {
  it('two adjacent latitudes are not one coordinate; a full longitude typed N still is', () => {
    expect(findCoordinates('LAT 593900N 594000N LONG')).toEqual([])
    const c = findCoordinates('520715N 0205330N')
    expect(c).toHaveLength(1)
    expect(c[0]!.lng).toBeCloseTo(20.8917, 3)
    expect(findCoordinates('593900N 594000N 0175600E').map(x => x.lat)).toEqual([expect.closeTo(59.6667, 3)])
  })
  it('offsets stay valid when the text has characters that upper-case to more than one', () => {
    const t = 'STRASSE ß 593922N0175612E ÆØ 593922N0175612E'
    const r = findCoordinates(t)
    expect(r.map(c => t.slice(c.start, c.end))).toEqual(['593922N0175612E', '593922N0175612E'])
  })
})
